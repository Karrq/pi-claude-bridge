#!/usr/bin/env node
// Does the extension's own cache-warming probe read back the prefix a real turn
// left cached — and does the next real turn then read what the probe refreshed?
//
// A warm probe is only worth its tokens if it reproduces the last real turn's
// request prefix exactly (cwd, env, settings, system prompt, model, MCP tool
// schemas, effort). Any difference makes Claude Code *write* the prefix instead
// of reading it, which costs more than not warming at all, and the divergence is
// invisible in the bridge's normal output — the probe still returns a result.
// This runs the real thing: a pi session through the bridge with cacheWarming
// enabled and a one-minute refresh, two real turns to establish the session the
// snapshot describes (a first turn is a clean start with nothing resumed to
// warm), an idle wait for the scheduler's probe, then one more real turn.
//
//   node diag/probe-warm-replay.mjs [--model claude-bridge/claude-haiku-4-5]
//       [--thinking low|off] [--refresh 1] [--window 10] [--wait 180]
//       [--out DIR] [--keep]
//
// The numbers come from the bridge debug log (CLAUDE_BRIDGE_DEBUG=1):
//   cache-warming: armed (...) promptTokens=N   prompt size of the real turn
//   warm-replay: resume=… cacheRead=X cacheWrite=Y cacheWrite1h=Z
//   cache-warming: refreshed …                  the probe reported a hit
//   usage: in=… cacheRead=X …                   the next real turn's usage
// diag/capture-proxy.mjs would add the two request bodies, which is what to
// reach for when this probe fails and the divergent element needs naming; the
// pass/fail condition itself is entirely in the numbers above, and going through
// a proxy would put another process in the path for no extra signal.
//
// Failing conditions (non-zero exit):
//   - the probe read less than half of `armed … promptTokens` (prefix diverged —
//     the message names the log line to read next)
//   - the real turn after the probe read less than half of what the probe read
//     (the probe refreshed an entry the next turn does not use)
//   - the probe wrote the real session file (isolation violation, when the file
//     can be located)
//
// pi's own config and sessions are isolated in a temp PI_CODING_AGENT_DIR, so
// the user's claude-bridge.json is only ever read, never written; that dir and
// the temp project dir are removed on success (--keep preserves them, and any
// failure preserves them for inspection). Claude Code itself still uses the real
// ~/.claude for its credentials and writes one session file there, exactly as the
// integration tests do; its path is printed.
//
// Requires: the `pi` CLI, Claude Code with working auth, and a cheap bridge model
// (haiku by default). Spends real tokens: two short turns plus at least one
// probe (a cache read of the whole prompt).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getClaudeDir, getProjectDir } from "cc-session-io";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const MODEL = flag("model", "claude-bridge/claude-haiku-4-5");
const THINKING = flag("thinking", "off");
const REFRESH_MIN = Number(flag("refresh", 1));
const WINDOW_MIN = Number(flag("window", 10));
const WAIT_S = Number(flag("wait", 180));
const KEEP = has("keep");
// An explicit --out belongs to the caller; a default temp dir is ours to remove.
const OWN_OUT = !args.includes("--out");
const OUT = flag("out") ?? mkdtempSync(join(tmpdir(), "warm-replay-probe-"));

// Under 60 chars, so the bridge's `prompt=` debug field carries the whole marker.
const TURN = {
	one: "warm probe turn one: reply with the single word alpha",
	two: "warm probe turn two: reply with the single word beta",
	three: "warm probe turn three: reply with the single word gamma",
};

const out = (line = "") => console.log(line);
const fail = (message, hint) => {
	console.error(`\nFAIL: ${message}`);
	if (hint) console.error(`      ${hint}`);
	process.exitCode = 1;
};

// --- pi RPC driver -----------------------------------------------------------

/** Minimal RPC driver: pi --mode rpc stays alive between prompts, which is what
 *  gives the scheduler an idle window to fire in. */
function startPi({ cwd, env, logPath }) {
	const child = spawn("pi", ["-ne", "-e", REPO, "--mode", "rpc", "--model", MODEL, ...(THINKING === "off" ? [] : ["--thinking", THINKING])], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env,
	});
	let buffer = "";
	const listeners = new Set();
	const stderr = [];
	let requestId = 0;

	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			let message;
			try { message = JSON.parse(line); } catch { continue; }
			for (const listener of [...listeners]) listener(message);
		}
	});
	child.stderr.on("data", (data) => {
		stderr.push(data.toString());
		if (stderr.length > 40) stderr.shift();
	});
	child.on("exit", (code, signal) => {
		for (const listener of [...listeners]) listener({ type: "__exit", code, signal });
	});

	const waitFor = (predicate, description, timeoutMs) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => { listeners.delete(onMessage); reject(new Error(`timeout waiting for ${description} (see ${logPath})`)); }, timeoutMs);
		const onMessage = (message) => {
			if (message.type === "__exit") {
				clearTimeout(timer);
				listeners.delete(onMessage);
				reject(new Error(`pi exited (${message.code ?? message.signal}) while waiting for ${description}: ${stderr.join("").slice(-800)}`));
				return;
			}
			if (!predicate(message)) return;
			clearTimeout(timer);
			listeners.delete(onMessage);
			resolve(message);
		};
		listeners.add(onMessage);
	});

	const prompt = async (text) => {
		const id = `req_${++requestId}`;
		const response = waitFor((m) => m.type === "response" && m.id === id, `response to ${id}`, 30_000);
		const ended = waitFor((m) => m.type === "agent_end", `agent_end for ${id}`, 10 * 60_000);
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: text, id })}\n`);
		const reply = await response;
		if (reply.success === false) throw new Error(`prompt rejected: ${reply.error}`);
		await ended;
	};

	return {
		prompt,
		stop: () => { child.kill(); },
	};
}

// --- Debug-log readers ------------------------------------------------------

const readLog = (path) => {
	try { return readFileSync(path, "utf8"); } catch { return ""; }
};

/** Log lines with the `[timestamp] [module] ` prefix stripped. */
const logLines = (path) => readLog(path).split("\n").map((line) => line.replace(/^\[[^\]]*\] \[[^\]]*\] /, ""));

/** The newest `cache-warming: armed (...) promptTokens=N` line, i.e. the prompt
 *  size of the turn whose prefix the probe is supposed to read. */
function armedPromptTokens(lines, marker) {
	const turnLine = lines.findIndex((line) => line.startsWith("provider: fresh query") && line.includes(`prompt=${marker}`));
	let armed = null;
	for (let i = turnLine === -1 ? 0 : turnLine; i < lines.length; i++) {
		const m = lines[i].match(/^cache-warming: armed \([^)]*\) promptTokens=(\d+)/);
		if (m) armed = Number(m[1]);
	}
	return { turnLine, armed };
}
/** Probe result lines, newest last. */
function probeResults(lines) {
	return lines.flatMap((line, at) => {
		const m = line.match(/^warm-replay: resume=(\S+) model=(\S+) cacheRead=(\d+) cacheWrite=(\d+) cacheWrite1h=(\d+)/);
		return m ? [{ at, resume: m[1], model: m[2], cacheRead: Number(m[3]), cacheWrite: Number(m[4]), cacheWrite1h: Number(m[5]) }] : [];
	});
}

/** The first usage the bridge logged for the turn whose prompt opened at `from`. */
function usageAfterPrompt(lines, marker) {
	const start = lines.findIndex((line) => line.startsWith("provider: fresh query") && line.includes(`prompt=${marker}`));
	if (start === -1) return null;
	const resume = lines[start].match(/resume=(\S+)/)?.[1] ?? null;
	for (let i = start; i < lines.length; i++) {
		const m = lines[i].match(/^usage: in=(\d+) out=(\d+) cacheRead=(\d+) cacheWrite=(\d+) total=\d+.*cachePct=(\d+)%/);
		if (m) return { at: i, resume, input: Number(m[1]), output: Number(m[2]), cacheRead: Number(m[3]), cacheWrite: Number(m[4]), cachePct: Number(m[5]) };
	}
	return null;
}

/** The probe's own prompt is `ok <base36>-<n>`; finding it in the real session
 *  file would mean the probe wrote the session instead of forking it. */
function sessionFileHasProbePrompt(cwd, resumePrefix) {
	try {
		const dir = getProjectDir(cwd, getClaudeDir());
		const file = readdirSync(dir).find((name) => name.startsWith(resumePrefix));
		if (!file) return null;
		const text = readFileSync(join(dir, file), "utf8");
		const hit = text.match(/"(?:content|text)":"ok [0-9a-z]+-\d+"/);
		return { file: join(dir, file), probePrompt: hit ? hit[0] : null };
	} catch {
		return null;
	}
}

// --- Main -------------------------------------------------------------------

const cwd = join(OUT, "cwd"); // temp project dir: the only place the probe writes config
const agentDir = join(OUT, "agent"); // isolated pi config + sessions
mkdirSync(cwd, { recursive: true });
mkdirSync(join(cwd, ".pi"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(cwd, ".pi", "claude-bridge.json"), JSON.stringify({
	cacheWarming: {
		enabled: true,
		windowMinutes: WINDOW_MIN,
		refreshMinutes: REFRESH_MIN,
		// Gates opened so the probe fires on a short, cheap session. minExpectedSavings
		// must go negative: a few-thousand-token prompt cannot clear the $0.05 default.
		minPromptTokens: 1,
		continuationProbability: 0.3,
		minExpectedSavings: -1,
		maxReplays: 3,
	},
}, null, 2) + "\n");
// pi's auth lives in the agent dir we are relocating; link rather than copy so
// no credentials are duplicated into the temp dir. Respect an already-set
// PI_CODING_AGENT_DIR as the source, since that is where this user's auth is.
const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
const realAuth = join(realAgentDir, "auth.json");
if (existsSync(realAuth)) symlinkSync(realAuth, join(agentDir, "auth.json"));

const debugLog = join(OUT, "bridge-debug.log");
const PATH = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const started = Date.now();
out(`warm-replay probe  model ${MODEL}  thinking ${THINKING}  refresh ${REFRESH_MIN}m  window ${WINDOW_MIN}m`);
out(`  temp config: ${cwd}/.pi/claude-bridge.json   pi agent dir: ${agentDir}`);
out(`  bridge debug log: ${debugLog}`);

const pi = startPi({
	cwd,
	env: {
		...process.env,
		PATH,
		PI_CODING_AGENT_DIR: agentDir,
		CLAUDE_BRIDGE_DEBUG: "1",
		CLAUDE_BRIDGE_DEBUG_PATH: debugLog,
	},
	logPath: debugLog,
});

let passed = false;
try {
	await delay(2500);
	await pi.prompt(TURN.one);
	await pi.prompt(TURN.two);
	const beforeProbe = logLines(debugLog);
	const { turnLine, armed } = armedPromptTokens(beforeProbe, TURN.two.slice(0, 40));
	if (turnLine === -1) throw new Error(`the second turn never reached the bridge provider; see ${debugLog}`);
	if (!armed) throw new Error(`no "cache-warming: armed … promptTokens=" line: warming did not arm (see ${debugLog})`);
	out(`  turn 1 (clean start) and turn 2 (arms the window) done: promptTokens=${armed}`);

	// Wait for the scheduler's probe. It is due REFRESH_MIN after turn 2.
	const deadline = Date.now() + WAIT_S * 1000;
	let probe = null;
	while (Date.now() < deadline) {
		await delay(2000);
		const lines = logLines(debugLog);
		const diverged = lines.filter((line) => line.startsWith("cache-warming: prefix diverged") || line.startsWith("cache-warming: probe reported no cache usage"));
		probe = probeResults(lines).at(-1) ?? null;
		if (probe) break;
		if (diverged.length) {
			// A divergence also idles out the whole window, so waiting longer cannot help.
			fail(`the probe did not read the real prefix — the scheduler's own hit check stopped the window: "${diverged.at(-1)}"`,
				`a divergence means the probe's request differs from the real turn's (see warm-replay.ts); inspect the request bodies with diag/capture-proxy.mjs`);
			throw new Error("probe diverged");
		}
		const stopped = lines.filter((line) => /^cache-warming: (warming window|snapshot stale|prompt \d+ tokens below|expected savings|cache economics)/.test(line)).at(-1);
		if (stopped) {
			fail(`warming never probed: "${stopped}"`, "the probe's own gates (minPromptTokens, minExpectedSavings, window) should be open with this script's config");
			throw new Error("warming stopped before probing");
		}
	}
	if (!probe) {
		fail(`no probe ran within ${WAIT_S}s of the second turn; see ${debugLog}`, `raise --wait (the scheduler refreshes ${REFRESH_MIN}m after the turn)`);
		throw new Error("no probe");
	}
	const waited = Math.round((Date.now() - started) / 1000);
	out(`  probe fired after ~${waited}s:  cacheRead=${probe.cacheRead}  cacheWrite=${probe.cacheWrite}  cacheWrite1h=${probe.cacheWrite1h}`);

	await pi.prompt(TURN.three);
	const lines = logLines(debugLog);
	const real = usageAfterPrompt(lines, TURN.three.slice(0, 40));
	if (!real) throw new Error(`the third turn's usage never reached the bridge log; see ${debugLog}`);
	out(`  turn 3 (after the probe):       cacheRead=${real.cacheRead}  cacheWrite=${real.cacheWrite}  cachePct=${real.cachePct}%  resume=${real.resume}`);
	if (real.resume && real.resume !== probe.resume) {
		fail(`the real turn resumed ${real.resume}, not the session the probe read (${probe.resume}) — the probe disturbed the session`,
			`see ${debugLog}`);
		throw new Error("session changed under the probe");
	}

	const session = sessionFileHasProbePrompt(cwd, probe.resume);
	if (session?.probePrompt) {
		fail(`the probe wrote its own prompt into the real session file (${session.file}): ${session.probePrompt}`,
			"the probe must run against a fork (forkSession: true, persistSession: false) — see warm-replay.ts");
		throw new Error("probe wrote the real session");
	}
	out(`  isolation: ${session ? `no probe prompt in ${session.file}` : "real session file not located (skipped)"}`);

	// --- Verdict ---
	const probeFloor = Math.floor(armed / 2);
	const realFloor = Math.floor(probe.cacheRead / 2);
	out("");
	if (probe.cacheRead < probeFloor) {
		fail(`probe read ${probe.cacheRead} of ${armed} prompt tokens (< 50%): the probe's prefix diverged from the real turn's`);
	} else if (real.cacheRead < realFloor) {
		fail(`the real turn after the probe read ${real.cacheRead}, less than half of the probe's ${probe.cacheRead}: the probe refreshed an entry the turn does not read`);
	} else {
		passed = true;
		console.log(`PASS: probe read ${probe.cacheRead}/${armed} tokens (${Math.round(probe.cacheRead / armed * 100)}%) of the real prefix,`);
		console.log(`      and the next real turn read ${real.cacheRead} of them back (${Math.round(real.cacheRead / probe.cacheRead * 100)}% of the probe's read).`);
		console.log(`      probe wrote ${probe.cacheWrite} tokens (${probe.cacheWrite1h} in the 1h bucket); real turn wrote ${real.cacheWrite}.`);
	}
} catch (error) {
	if (!process.exitCode) {
		console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
	if (OWN_OUT && !KEEP) console.error(`      output: ${OUT}`);
} finally {
	pi.stop();
	await delay(500);
	if (passed && OWN_OUT && !KEEP) rmSync(OUT, { recursive: true, force: true });
	else if (OWN_OUT) out(`\noutput: ${OUT}`);
}

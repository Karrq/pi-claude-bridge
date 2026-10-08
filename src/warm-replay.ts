// One prompt-cache refresh against an isolated fork of the shared Claude Code
// session.
//
// The refresh only counts if the SDK sends the *same request prefix* the last
// real turn produced: same cwd, env, settings, system prompt, model, tools and
// effort. Anything that differs rewrites the cache entry instead of reading it,
// which costs more than not warming at all. So the options come from the same
// builder the provider path uses (buildProviderQueryOptions in index.ts) fed
// with the snapshot index.ts recorded from that real turn.
//
// The request is deliberately isolated: `forkSession: true` plus
// `persistSession: false` mean Claude Code resumes the transcript into a new
// session id it does not write back, so nothing here can mutate the real
// session file, pi's transcript, or any bridge session state. This module
// touches none of that — no consumeQuery, no syncSharedSession, no
// persistSessionPointer, no prompt capture, no ctx().activeQuery.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@earendil-works/pi-ai";
import { createToolServer } from "./mcp-server.js";
import { MCP_SERVER_NAME } from "./skills.js";
import type { ProviderMcpServers } from "./index.js";
import type { WarmSnapshot, WarmUsage } from "./warm-scheduler.js";

/** The MCP servers a probe serves, in the same shape the provider path passes
 *  the SDK. `tools: []` is not a divergence between the provider path and the
 *  real turn — the provider takes its tool schemas from mcpServers — so a probe
 *  has to expose the real turn's tool definitions too or it warms a request
 *  whose tools block differs. */
export type ReplayMcpServers = ProviderMcpServers;

let probeSeq = 0;

/**
 * Prompt for the probe. Its content does not matter for the cache read — the
 * read is of everything ahead of it — but it must not repeat byte-for-byte
 * between probes.
 *
 * Claude Code puts its message cache breakpoint on the newest message, so a
 * probe writes a *new* entry ending at this prompt. If the next probe sent the
 * identical text, that probe would hit its predecessor's entry at distance 0
 * and never touch the entry the next real turn reads (which ends at the last
 * real message, one block back from here). A unique tail forces the lookup to
 * fall back one block and re-read — and thereby refresh — the entry the real
 * turn needs. See diag/AUDIT.md: CC's breakpoints are the end of the system
 * prompt and the newest message.
 */
function probePrompt(): string {
	probeSeq += 1;
	return `ok ${Date.now().toString(36)}-${probeSeq.toString(36)}`;
}

/**
 * The probe's tool servers: identical definitions to the real turn's, with
 * handlers that fail immediately. The real handlers park until pi delivers a
 * tool result, which a probe can never supply — a probe that called a tool
 * would hang its Claude Code process forever instead of failing a turn nobody
 * is watching.
 */
export function buildReplayMcpServers(tools: Tool[]): ReplayMcpServers {
	if (!tools.length) return undefined;
	const servers = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> => ({
			content: [{ type: "text", text: "claude-bridge: warm probe does not execute tools" }],
			isError: true,
		}),
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, servers) };
}

/** Cache counters off an Anthropic usage frame, in either shape Claude Code
 *  reports them: the flat `cache_*_input_tokens` fields and the `cache_creation`
 *  breakdown that splits the write between the 5-minute and 1-hour entries. */
function usageFromFrame(usage: {
	input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_creation?: { ephemeral_1h_input_tokens?: number | null; ephemeral_5m_input_tokens?: number | null } | null;
} | null | undefined): WarmUsage | undefined {
	if (!usage) return undefined;
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const cacheWrite = usage.cache_creation_input_tokens ?? 0;
	const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
	// A frame with nothing measurable (e.g. a startup failure result) is not a result.
	if (cacheRead === 0 && cacheWrite === 0) return undefined;
	return { cacheRead, cacheWrite, cacheWrite1h };
}

export type RunWarmReplayOptions = {
	snapshot: WarmSnapshot;
	mcpServers: ReplayMcpServers;
	extraArgs: Record<string, string | null>;
	claudeExecutable?: string;
	signal?: AbortSignal;
};

/**
 * Send one probe and return the cache usage it produced, or undefined if the
 * probe could not produce one. Never throws: the caller is a timer.
 */
export async function runWarmReplay(opts: RunWarmReplayOptions): Promise<WarmUsage | undefined> {
	// Imported at call time rather than statically: index.ts imports this module
	// for its hook wiring, so a static import would close a module cycle.
	const { buildProviderQueryOptions, debug } = await import("./index.js");
	const { snapshot } = opts;
	const options = buildProviderQueryOptions({
		cwd: snapshot.cwd,
		model: snapshot.cliModel,
		side: false,
		systemPromptAppend: snapshot.systemPromptAppend,
		mcpServers: opts.mcpServers,
		effort: snapshot.effort,
		extraArgs: opts.extraArgs,
		resumeSessionId: snapshot.ccSessionId,
		claudeExecutable: opts.claudeExecutable,
		forkSession: true,
		persistSession: false,
		maxTurns: 1,
		tools: [],
		debugTag: "warm-probe",
	});

	let sdkQuery: ReturnType<typeof query> | undefined;
	let usage: WarmUsage | undefined;
	try {
		sdkQuery = query({ prompt: probePrompt(), options });
		const onAbort = () => { try { sdkQuery?.close(); } catch {} };
		if (opts.signal) {
			if (opts.signal.aborted) return undefined;
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			for await (const message of sdkQuery) {
				if (message.type === "result") {
					usage = usageFromFrame(message.usage);
					break;
				}
				if (message.type === "stream_event" && message.event.type === "message_start") {
					// The prompt cache is written while the request is processed, before
					// any token streams, so message_start already carries the refresh.
					// Stop here rather than pay for an answer nobody reads: the probe's
					// own output tokens come out of the same budget as the savings.
					usage = usageFromFrame(message.event.message.usage);
					if (usage) break;
				}
			}
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
		}
	} catch (error) {
		debug(`warm-replay: probe failed resume=${snapshot.ccSessionId.slice(0, 8)} model=${snapshot.cliModel}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		try { sdkQuery?.close(); } catch {}
	}
	if (!usage) {
		debug(`warm-replay: no cache usage reported resume=${snapshot.ccSessionId.slice(0, 8)} model=${snapshot.cliModel}`);
		return undefined;
	}
	debug(`warm-replay: resume=${snapshot.ccSessionId.slice(0, 8)} model=${snapshot.cliModel} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} cacheWrite1h=${usage.cacheWrite1h}`);
	return usage;
}

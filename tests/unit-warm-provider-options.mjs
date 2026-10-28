/**
 * Pins the extraction of the provider query-options builder (P1): the options
 * object the provider path sends is the whole of the request prefix a
 * cache-warming probe has to reproduce, so a change in shape here silently
 * turns every warm refresh into a cache rewrite. The main-path key list is
 * asserted in order, which is what "byte-identical to the inline builder"
 * reduces to for an object literal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildProviderExtraArgs, buildProviderQueryOptions, warmSnapshotKey } = await import("../src/index.js");

// Fields only present when CLAUDE_BRIDGE_DEBUG=1 (makeCliDebugOptions).
const DEBUG_KEYS = ["debug", "debugFile", "stderr"];
const withoutDebugKeys = (options) => Object.keys(options).filter((key) => !DEBUG_KEYS.includes(key));

const base = { cwd: "/tmp/proj", model: "claude-sonnet-5-5", side: false, extraArgs: { model: "claude-sonnet-5-5" } };

describe("buildProviderQueryOptions", () => {
	it("provider path produces the same option set, in the same order, as the inline builder", () => {
		const options = buildProviderQueryOptions({ ...base, systemPromptAppend: "APPEND" });
		assert.deepEqual(withoutDebugKeys(options), [
			"cwd", "env", "tools", "permissionMode", "includePartialMessages",
			"settings", "systemPrompt", "extraArgs",
		]);
		assert.equal(options.cwd, "/tmp/proj");
		assert.equal(options.permissionMode, "bypassPermissions");
		assert.equal(options.includePartialMessages, true);
		assert.deepEqual(options.tools, [], "tools stays empty; tool schemas come from mcpServers");
		assert.deepEqual(options.settings, {
			autoMemoryEnabled: false,
			claudeMdExcludes: ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"],
			includeGitInstructions: false,
		});
		assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", append: "APPEND" });
		// Every Claude Code child carries the env guard (see tests/unit-child-env.mjs).
		assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
		assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
		assert.equal(options.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS, "1");
		// Nothing warm-only on the provider path.
		for (const key of ["resume", "effort", "mcpServers", "pathToClaudeCodeExecutable", "forkSession", "persistSession", "maxTurns"]) {
			assert.equal(options[key], undefined, `${key} absent when not requested`);
		}
	});

	it("side path replaces the preset with the caller's own prompt", () => {
		const options = buildProviderQueryOptions({ ...base, side: true, sideSystemPrompt: "you are a summarizer" });
		assert.equal(options.systemPrompt, "you are a summarizer");
	});

	it("carries every field a warm probe must reproduce", () => {
		const mcpServers = { pi: { type: "sdk", name: "pi", instance: {} } };
		const options = buildProviderQueryOptions({
			...base,
			systemPromptAppend: "APPEND",
			effort: "high",
			mcpServers,
			resumeSessionId: "cc-session-1",
			claudeExecutable: "/usr/local/bin/claude",
			forkSession: true,
			persistSession: false,
			maxTurns: 1,
			tools: [],
		});
		assert.equal(options.resume, "cc-session-1");
		assert.equal(options.effort, "high");
		assert.equal(options.mcpServers, mcpServers);
		assert.equal(options.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
		assert.equal(options.forkSession, true, "the probe forks rather than continuing the real session");
		assert.equal(options.persistSession, false, "the probe writes no session file");
		assert.equal(options.maxTurns, 1);
		assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", append: "APPEND" });
	});
});

describe("buildProviderExtraArgs", () => {
	it("always names the CLI model and pins the MCP config", () => {
		assert.deepEqual(buildProviderExtraArgs("claude-sonnet-5-5", undefined), {
			model: "claude-sonnet-5-5",
			"replay-user-messages": null,
			"strict-mcp-config": null,
		});
	});

	it("asks for summarized thinking only when an effort level is sent", () => {
		assert.deepEqual(buildProviderExtraArgs("claude-opus-5", "high"), {
			model: "claude-opus-5",
			"replay-user-messages": null,
			"strict-mcp-config": null,
			"thinking-display": "summarized",
		});
	});
});

describe("warmSnapshotKey", () => {
	it("separates session and model so one session can hold several windows", () => {
		assert.notEqual(warmSnapshotKey("pi-1", "claude-opus-5"), warmSnapshotKey("pi-1", "claude-sonnet-5-5"));
		assert.notEqual(warmSnapshotKey("pi-1", "claude-opus-5"), warmSnapshotKey("pi-2", "claude-opus-5"));
	});
});

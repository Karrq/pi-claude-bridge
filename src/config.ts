// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json)
// and the project Pi config directory, project overriding global. Missing or
// unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface Config {
	/** Date (YYYY-MM-DD) the one-time startup notice was shown. Written by the extension, not the user. */
	startupNoticeShown?: string;
	/** Date (YYYY-MM-DD) the AskClaude deprecation notice was shown. Written by the extension, not the user. */
	askClaudeDeprecationShown?: string;
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	webSearch?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		// Model that executes the search. Defaults to "haiku" — its only job is
		// calling the WebSearch tool once, so a small model is cheap and sufficient.
		model?: string;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// In-process MITM proxy recording every Claude Code child's outbound API
		// traffic (request bodies, cache_control placement, usage) for debugging
		// prompt-cache behavior. Off by default — a capture writes full
		// conversation content to disk unencrypted, and the extension warns once
		// per process when it's on. See diag/AUDIT.md and diag/capture-proxy.mjs,
		// which src/debug-capture-proxy.ts mirrors.
		debugCaptureProxy?: {
			enabled?: boolean;
			// Defaults to <agent dir>/claude-bridge-captures/<timestamp>-<instance id>.
			outDir?: string;
		};
		// Model ids (e.g. "claude-future-9") whose declared 1M context Claude Code
		// does not actually serve; pins them to the bare id at 200K.
		forceTwoHundredK?: string[];
	};
	/**
	 * Extension-owned prompt-cache warming. Pi's native warmer is capped at a
	 * 30-minute idle window and a 60-minute streaming window (hardcoded in
	 * dist/core/cache-warmer.js), so keeping a cache warm across a long idle gap
	 * needs a scheduler of our own. While this is enabled the extension vetoes
	 * pi's native warmer (cache_warming_decision -> stop); disable it and native
	 * warming takes over unchanged.
	 */
	cacheWarming?: {
		/** Master switch. Default false. */
		enabled?: boolean;
		/** Keep refreshing for this long after the last real turn. Default 360. */
		windowMinutes?: number;
		/** Refresh cadence, in minutes. Must stay under the 60-minute 1h cache TTL.
		 *  Default 54 (90% of the TTL, matching pi's own margin). */
		refreshMinutes?: number;
		/** Skip warming below this prompt size (tokens). Default 50000. */
		minPromptTokens?: number;
		/** Estimated chance a real turn returns within the TTL; drives the
		 *  expected-savings gate. Default 0.3. */
		continuationProbability?: number;
		/** Minimum expected dollar savings per refresh. Default 0.05. */
		minExpectedSavings?: number;
		/** Hard cap on refreshes per window, a quota guard. Default 8. */
		maxReplays?: number;
		/** Notify on each successful refresh (a toast with the window's run count)
		 *  and record a `claude-bridge:cache-warm` session entry. Default true. */
		notify?: boolean;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

/** Record today's date in the global config so the startup notice shows once, preserving every
 *  other field. Returns the config path for display either way.
 *
 *  Parses directly rather than through tryParseJson, which reports an unparseable file as `{}`:
 *  spreading that would replace a user's whole config with just this marker the first time they
 *  leave a trailing comma in it. Losing the notice is the cheaper failure, so the write is
 *  skipped and the notice simply shows again next session. */
export function markStartupNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	// en-CA renders YYYY-MM-DD in local time; toISOString() would report UTC.
	const next = { ...existing, startupNoticeShown: new Date().toLocaleDateString("en-CA") };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

/** Record when the AskClaude deprecation notice was shown in the global config, preserving every
 *  other field. Returns the config path either way. */
export function markAskClaudeDeprecationNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	// Match startupNoticeShown's local YYYY-MM-DD date format.
	const next = { ...existing, askClaudeDeprecationShown: new Date().toLocaleDateString("en-CA") };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	return {
		startupNoticeShown: project.startupNoticeShown ?? global.startupNoticeShown,
		askClaudeDeprecationShown: project.askClaudeDeprecationShown ?? global.askClaudeDeprecationShown,
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider: { ...global.provider, ...project.provider },
		webSearch: { ...global.webSearch, ...project.webSearch },
		cacheWarming: { ...global.cacheWarming, ...project.cacheWarming },
	};
}

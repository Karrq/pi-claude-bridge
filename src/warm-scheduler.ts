// Prompt-cache warming scheduler.
//
// Pi's native warmer keeps a cache entry alive for at most 30 idle minutes
// (MAX_IDLE_WARMING_AGE_MS in pi's dist/core/cache-warmer.js) because its
// continuation estimate gets unreliable with age. Claude Code writes 1-hour
// caches, so a long idle gap in a bridge session — the normal case for a
// conversation you come back to an hour later — outlives that window and the
// next real turn pays a full cache write. This scheduler owns the job instead:
// it re-arms itself every refreshMinutes for up to windowMinutes, sending a
// probe request (warm-replay.js) that re-reads the shared Claude Code prefix.
//
// Deliberately free of pi and Claude Code imports except types, and every
// external effect is injectable (replay, clock, timers, prices, config), so the
// whole policy is unit-testable without a subprocess. index.ts supplies the
// real dependencies and owns the hook wiring.

import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@earendil-works/pi-ai";

// --- Types ---

/** The request-defining parameters of the last real turn on a (pi session,
 *  model) pair. A probe that reproduces all of these reproduces the cached
 *  prefix; any difference rewrites the cache instead of reading it. */
export type WarmSnapshot = {
	piSessionId: string;
	ccSessionId: string;
	cwd: string;
	/** pi-registered model id — the scheduler's key, and the price-map key. */
	model: string;
	/** The id actually sent to Claude Code (may carry `[1m]`). */
	cliModel: string;
	effort?: EffortLevel;
	systemPromptAppend?: string;
	/** The real turn's resolved MCP tool list — `tools: []` is not a divergence,
	 *  so these schemas are the whole of the request's tools block. */
	mcpTools: Tool[];
	at: number;
};

/** What a probe read and wrote, as reported by the SDK result/stream frame. */
export type WarmUsage = {
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
};

/** Effective warming config. Applied defaults live in WARM_DEFAULTS. */
export type WarmConfig = {
	enabled: boolean;
	windowMinutes: number;
	refreshMinutes: number;
	minPromptTokens: number;
	continuationProbability: number;
	minExpectedSavings: number;
	maxReplays: number;
};

/** Prices in USD per million tokens. `cacheWrite1h` is the 1-hour write price. */
export type WarmModelPrice = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
};

export type WarmState = {
	key: string;
	piSessionId: string;
	model: string;
	snapshot: WarmSnapshot;
	/** Prompt size of the last real turn, in tokens — what a refresh reads. */
	promptTokens: number;
	armedAt: number;
	windowEndsAt: number;
	replays: number;
	timer?: WarmTimer;
	/** Why this state stopped scheduling; set by cancel and by every stop path. */
	stopped?: string;
};

export type WarmEconomics = {
	warmCost: number;
	missCost: number;
	continuationProbability: number;
	expectedSavings: number;
};

/** setTimeout's return type without requiring @types/node's DOM-free variant. */
export type WarmTimer = ReturnType<typeof setTimeout>;

export type WarmSchedulerDeps = {
	/** Send one probe. Resolves to the cache usage it read, or undefined on failure. */
	replay: (state: WarmState) => Promise<WarmUsage | undefined>;
	/** True while a real provider turn is running (see index.ts's ctx().activeQuery). */
	isQueryActive: () => boolean;
	/** Effective config; disabled (or absent) turns warming off entirely. */
	config: () => (Partial<WarmConfig> & { enabled?: boolean }) | undefined;
	/** Prices for a registered model id, or undefined when unknown. */
	price: (modelId: string) => WarmModelPrice | undefined;
	/** Optional extra staleness test (e.g. the CC session pointer moved). */
	isStale?: (snapshot: WarmSnapshot, now: number) => boolean;
	now?: () => number;
	log?: (message: string) => void;
	setTimer?: (fn: () => void, ms: number) => WarmTimer;
	clearTimer?: (timer: WarmTimer) => void;
};

/** Defaults, mirroring the documented defaults in config.ts. */
export const WARM_DEFAULTS = {
	windowMinutes: 360,
	refreshMinutes: 54,
	minPromptTokens: 50000,
	continuationProbability: 0.3,
	minExpectedSavings: 0.05,
	maxReplays: 8,
} as const;

/** Retry gap when the probe is skipped because a real query is running. Short
 *  enough to land in the same TTL, long enough not to spin. */
export const WARM_BUSY_RETRY_MS = 30_000;

const MINUTE_MS = 60_000;

// --- Module state ---

let deps: WarmSchedulerDeps | undefined;
const states = new Map<string, WarmState>();

/** Install the scheduler's dependencies. Called once from index.ts's activate(). */
export function configureWarmScheduler(next: WarmSchedulerDeps): void {
	deps = next;
}

function keyOf(piSessionId: string, model: string): string {
	return `${piSessionId}\u0000${model}`;
}

function nowOf(d: WarmSchedulerDeps): number {
	return d.now?.() ?? Date.now();
}

function logOf(d: WarmSchedulerDeps | undefined, message: string): void {
	d?.log?.(message);
}

function setTimerOf(d: WarmSchedulerDeps, fn: () => void, ms: number): WarmTimer {
	const timer = (d.setTimer ?? ((callback, delay) => setTimeout(callback, delay)))(fn, ms);
	// A pending probe must never hold the process open.
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

function clearTimerOf(d: WarmSchedulerDeps, timer: WarmTimer): void {
	(d.clearTimer ?? ((t) => clearTimeout(t)))(timer);
}

/** Resolve the injected config, applying defaults. Undefined unless enabled. */
function resolveConfig(d: WarmSchedulerDeps): WarmConfig | undefined {
	const raw = d.config();
	if (!raw?.enabled) return undefined;
	return {
		enabled: true,
		// Clamped: a zero or negative cadence would turn the timer into a hot loop
		// of paid cache reads.
		windowMinutes: Math.max(1, raw.windowMinutes ?? WARM_DEFAULTS.windowMinutes),
		refreshMinutes: Math.max(1, raw.refreshMinutes ?? WARM_DEFAULTS.refreshMinutes),
		minPromptTokens: raw.minPromptTokens ?? WARM_DEFAULTS.minPromptTokens,
		continuationProbability: raw.continuationProbability ?? WARM_DEFAULTS.continuationProbability,
		minExpectedSavings: raw.minExpectedSavings ?? WARM_DEFAULTS.minExpectedSavings,
		maxReplays: raw.maxReplays ?? WARM_DEFAULTS.maxReplays,
	};
}

function shortLabel(state: WarmState): string {
	return `${state.piSessionId.slice(0, 8)}/${state.model} replays=${state.replays}`;
}

function stop(state: WarmState, reason: string): void {
	if (state.timer) {
		if (deps) clearTimerOf(deps, state.timer);
		state.timer = undefined;
	}
	state.stopped = reason;
	logOf(deps, `cache-warming: ${reason} (${shortLabel(state)})`);
}

function schedule(state: WarmState, delayMs: number): void {
	const d = deps;
	if (!d) return;
	if (state.timer) clearTimerOf(d, state.timer);
	state.stopped = undefined;
	state.timer = setTimerOf(d, () => { void fire(state); }, delayMs);
}

// --- Cost estimation ---

/**
 * Prices for every model in a pi-ai catalog slice.
 *
 * Read from the catalog rather than from the registered models: `buildModels`
 * zeroes `cost` on purpose (the bridge bills through Claude Code's own
 * subscription accounting), so the real numbers only exist on the catalog
 * entries before that projection. Anthropic's 1-hour cache write costs 2x the
 * base input price and a read costs 0.1x, which is what `warmCost`/`missCost`
 * are built from.
 */
export function warmPriceMap(
	models: Array<{ id: string; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }>,
): Map<string, WarmModelPrice> {
	const prices = new Map<string, WarmModelPrice>();
	for (const model of models) {
		const cost = model.cost;
		if (!cost) continue;
		const input = cost.input ?? 0;
		prices.set(model.id, {
			input,
			output: cost.output ?? 0,
			cacheRead: cost.cacheRead ?? input * 0.1,
			cacheWrite: cost.cacheWrite ?? input * 1.25,
			cacheWrite1h: input * 2,
		});
	}
	return prices;
}

/**
 * `warmCost` is what a refresh costs unconditionally: a cache read of the whole
 * prompt plus one output token. `missCost` is the delta a real turn pays if the
 * entry is gone: a 1-hour cache write instead of a read. The expected saving is
 * the continuation-weighted missCost minus warmCost — negative whenever the
 * chance of an imminent real turn is too small to justify the read.
 */
export function estimateWarmEconomics(
	price: WarmModelPrice | undefined,
	promptTokens: number,
	continuationProbability: number,
): WarmEconomics | undefined {
	if (!price || promptTokens <= 0) return undefined;
	const perToken = 1 / 1_000_000;
	const warmCost = promptTokens * price.cacheRead * perToken + price.output * perToken;
	const missCost = promptTokens * Math.max(0, price.cacheWrite1h - price.cacheRead) * perToken;
	return {
		warmCost,
		missCost,
		continuationProbability,
		expectedSavings: continuationProbability * missCost - warmCost,
	};
}

// --- Public API ---

/**
 * Arm (or re-arm) warming for one (pi session, model) pair. Called on
 * turn_end/agent_settled with the snapshot the turn just recorded, and on
 * model_select for a model being switched back to.
 *
 * Upserts: a newer real turn replaces the previous window, including its replay
 * count. Other keys are untouched — that is what keeps a switch away and back
 * warm, and why nothing here cancels a sibling model.
 */
export function armForTurn(input: {
	piSessionId: string;
	model: string;
	snapshot: WarmSnapshot;
	promptTokens?: number;
}): WarmState | undefined {
	const d = deps;
	if (!d) return undefined;
	const config = resolveConfig(d);
	if (!config) return undefined;
	const now = nowOf(d);
	const { piSessionId, model, snapshot } = input;
	// A snapshot from a different turn/session is not this turn's prefix.
	if (snapshot.piSessionId !== piSessionId || snapshot.model !== model) {
		logOf(d, `cache-warming: snapshot mismatch (${snapshot.piSessionId.slice(0, 8)}/${snapshot.model} != ${piSessionId.slice(0, 8)}/${model})`);
		return undefined;
	}
	const key = keyOf(piSessionId, model);
	const previous = states.get(key);
	if (previous?.timer) clearTimerOf(d, previous.timer);
	const state: WarmState = {
		key,
		piSessionId,
		model,
		snapshot,
		promptTokens: input.promptTokens ?? previous?.promptTokens ?? 0,
		armedAt: now,
		// The window is measured from the real turn the snapshot came from, so a
		// session left idle longer than windowMinutes is not warmed at all.
		windowEndsAt: snapshot.at + config.windowMinutes * MINUTE_MS,
		replays: 0,
	};
	states.set(key, state);

	if (now >= state.windowEndsAt) {
		stop(state, "warming window already elapsed");
		return state;
	}
	if (d.isStale?.(snapshot, now)) {
		stop(state, "snapshot stale");
		return state;
	}
	if (state.promptTokens < config.minPromptTokens) {
		stop(state, `prompt ${state.promptTokens} tokens below minPromptTokens ${config.minPromptTokens}`);
		return state;
	}
	logOf(d, `cache-warming: armed (${shortLabel(state)}) promptTokens=${state.promptTokens} refresh=${config.refreshMinutes}m window=${config.windowMinutes}m`);
	schedule(state, config.refreshMinutes * MINUTE_MS);
	return state;
}

/**
 * One scheduled refresh. Every exit either re-arms or stops the window; nothing
 * here throws, since the timer has no caller to catch it.
 */
async function fire(state: WarmState): Promise<void> {
	state.timer = undefined;
	const d = deps;
	// Cancelled or superseded by a newer turn while the timer was pending.
	if (!d || states.get(state.key) !== state) return;
	const config = resolveConfig(d);
	if (!config) {
		stop(state, "cache warming disabled");
		return;
	}
	const now = nowOf(d);
	if (now >= state.windowEndsAt) {
		stop(state, "warming window elapsed");
		return;
	}
	// A real turn is running: a probe would race its Claude Code process for the
	// same session file, and its request would be a duplicate of the live one.
	// Re-arm shortly instead of dropping the window.
	if (d.isQueryActive()) {
		logOf(d, `cache-warming: real query active, retrying in ${Math.round(WARM_BUSY_RETRY_MS / 1000)}s (${shortLabel(state)})`);
		schedule(state, Math.min(WARM_BUSY_RETRY_MS, Math.max(1, state.windowEndsAt - now)));
		return;
	}

	const economics = estimateWarmEconomics(d.price(state.snapshot.model), state.promptTokens, config.continuationProbability);
	if (!economics) {
		stop(state, "cache economics unavailable");
		return;
	}
	if (economics.expectedSavings < config.minExpectedSavings) {
		stop(state, `expected savings $${economics.expectedSavings.toFixed(4)} below $${config.minExpectedSavings}`);
		return;
	}

	logOf(d, `cache-warming: refresh (${shortLabel(state)}) warmCost=$${economics.warmCost.toFixed(4)} missCost=$${economics.missCost.toFixed(4)} expectedSavings=$${economics.expectedSavings.toFixed(4)}`);
	let usage: WarmUsage | undefined;
	try {
		usage = await d.replay(state);
	} catch (error) {
		// Best-effort: a failed probe must not disturb the session, and there is
		// no caller to surface it to.
		stop(state, `replay failed: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (states.get(state.key) !== state) return;

	if (!usage) {
		// No counters at all: a failed or unreadable probe. Not a refresh, so it does
		// not spend the replay quota, but there is nothing to keep warming from.
		stop(state, "probe reported no cache usage");
		return;
	}
	state.replays += 1;
	// A probe that read nothing rewrote the cache instead of refreshing it: we
	// are paying write prices for the prefix, which is worse than not warming, so
	// stop the window rather than keep buying writes every 54 minutes.
	const hitFloor = state.promptTokens > 0 ? Math.floor(state.promptTokens / 2) : 1;
	if (usage.cacheRead < hitFloor) {
		stop(state, `prefix diverged (cacheRead=${usage.cacheRead}, promptTokens=${state.promptTokens}) — stopping window`);
		return;
	}
	logOf(d, `cache-warming: refreshed (${shortLabel(state)}) cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} cacheWrite1h=${usage.cacheWrite1h}`);

	const after = nowOf(d);
	if (state.replays >= config.maxReplays) {
		stop(state, `maxReplays ${config.maxReplays} reached`);
		return;
	}
	if (after >= state.windowEndsAt) {
		stop(state, "warming window elapsed");
		return;
	}
	schedule(state, config.refreshMinutes * MINUTE_MS);
}

/** Stop one key, keeping the state (with `stopped` set) for inspection. */
export function cancelKey(key: string, reason: string): void {
	const state = states.get(key);
	if (!state) return;
	if (state.timer) {
		if (deps) clearTimerOf(deps, state.timer);
		state.timer = undefined;
	}
	state.stopped = reason;
	logOf(deps, `cache-warming: cancelled (${shortLabel(state)}) — ${reason}`);
}

/** Stop every model's window for one pi session (history rewritten, session ending). */
export function cancelSession(piSessionId: string, reason: string): void {
	const prefix = `${piSessionId}\u0000`;
	for (const key of [...states.keys()]) {
		if (key.startsWith(prefix)) cancelKey(key, reason);
	}
}

/** Key for a (pi session, model) pair, for callers that only have the pair. */
export function warmKey(piSessionId: string, model: string): string {
	return keyOf(piSessionId, model);
}

/** Stop everything and forget every window (session_shutdown, /reload). */
export function cancelAll(reason: string): void {
	for (const state of states.values()) {
		if (state.timer) {
			if (deps) clearTimerOf(deps, state.timer);
			state.timer = undefined;
		}
		state.stopped = reason;
	}
	states.clear();
}

/** Live windows, for tests and diagnostics. */
export function warmStates(): WarmState[] {
	return [...states.values()];
}

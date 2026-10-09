/**
 * Cache-warming scheduler policy: cadence, window, cost gate, hit verification,
 * replay cap, and the per-(session, model) keying that keeps a model switch from
 * killing the previous model's window.
 *
 * Every effect is injected, so these run with a manual clock and recorded
 * timers and never spawn Claude Code. Timers are fired by hand: the scheduler's
 * callback discards the promise, so a fired timer is settled with `tick()`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	WARM_BUSY_RETRY_MS,
	WARM_DEFAULTS,
	armForTurn,
	cancelAll,
	cancelKey,
	cancelSession,
	configureWarmScheduler,
	estimateWarmEconomics,
	warmKey,
	warmPriceMap,
	warmStates,
} from "../src/warm-scheduler.js";

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const PRICES = new Map([
	[SONNET, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 }],
	[OPUS, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }],
]);

const BIG_PROMPT = 100_000;
const HIT = (state) => ({ cacheRead: state.promptTokens, cacheWrite: 500, cacheWrite1h: 500 });

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ config = { enabled: true }, now: startNow = 1_000_000, usage = HIT, deps: overrides = {} } = {}) {
	let now = startNow;
	let queryActive = false;
	const timers = [];
	const replays = [];
	const logs = [];
	const refreshes = [];
	const stops = [];
	configureWarmScheduler({
		replay: async (state) => { replays.push(state); return usage(state); },
		isQueryActive: () => queryActive,
		config: () => config,
		price: (modelId) => PRICES.get(modelId),
		now: () => now,
		log: (message) => logs.push(message),
		setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false, fired: false }; timers.push(timer); return timer; },
		clearTimer: (timer) => { timer.cleared = true; },
		onRefreshed: (state, usage, economics) => { refreshes.push({ state, usage, economics }); },
		onStopped: (state, reason) => { stops.push({ state, reason }); },
		...overrides,
	});
	const h = {
		timers, replays, logs, refreshes, stops,
		advance(ms) { now += ms; },
		get now() { return now; },
		setQueryActive(value) { queryActive = value; },
		snapshot(patch = {}) {
			return { piSessionId: "pi-1", ccSessionId: "cc-1", cwd: "/tmp/proj", model: SONNET, cliModel: SONNET, at: now, mcpTools: [], ...patch };
		},
		/** The newest timer that is neither spent nor cleared. */
		pending() { return timers.filter((timer) => !timer.cleared && !timer.fired).at(-1); },
		/** Fire the newest pending timer and let the async fire() settle. */
		async fire() {
			const timer = h.pending();
			assert.ok(timer, "expected a pending timer to fire");
			timer.fired = true;
			timer.fn();
			await tick();
		},
		arm({ model = SONNET, piSessionId = "pi-1", promptTokens = BIG_PROMPT } = {}) {
			return armForTurn({
				piSessionId,
				model,
				snapshot: h.snapshot({ piSessionId, model, cliModel: model }),
				promptTokens,
			});
		},
	};
	return h;
}

describe("warm scheduler", () => {
	beforeEach(() => {
		cancelAll("test reset");
		configureWarmScheduler(undefined);
	});

	it("arms a refresh at the configured cadence, inside the window", () => {
		const h = harness({ config: { enabled: true, refreshMinutes: 54, windowMinutes: 360 } });
		const state = h.arm();
		assert.equal(state.replays, 0);
		assert.equal(state.stopped, undefined);
		assert.equal(h.pending().ms, 54 * 60_000);
		assert.equal(state.nextFireAt, h.now + 54 * 60_000, "the next probe time is readable while armed");
		assert.equal(state.windowEndsAt, h.now + 360 * 60_000);
	});

	it("forgets the next fire time once the window is cancelled", () => {
		const h = harness();
		const state = h.arm();
		assert.ok(state.nextFireAt);
		cancelKey(state.key, "session ended");
		assert.equal(state.nextFireAt, undefined);
	});

	it("applies documented defaults when the config omits them", () => {
		const h = harness();
		const state = h.arm();
		assert.equal(h.pending().ms, WARM_DEFAULTS.refreshMinutes * 60_000);
		assert.equal(state.windowEndsAt - state.snapshot.at, WARM_DEFAULTS.windowMinutes * 60_000);
	});

	it("re-arms after a refresh, and stops at maxReplays", async () => {
		const h = harness({ config: { enabled: true, maxReplays: 3 } });
		const state = h.arm();
		for (let i = 0; i < 3; i++) {
			await h.fire();
			h.advance(54 * 60_000);
		}
		assert.equal(h.replays.length, 3, "one probe per scheduled refresh");
		assert.equal(state.replays, 3);
		assert.match(state.stopped, /maxReplays 3/);
		assert.equal(h.pending(), undefined, "no further refresh after the quota is spent");
	});

	it("stops the window once the window itself has elapsed", async () => {
		const h = harness({ config: { enabled: true, windowMinutes: 60 } });
		const state = h.arm();
		h.advance(60 * 60_000);
		await h.fire();
		assert.equal(h.replays.length, 0);
		assert.match(state.stopped, /window elapsed/);
		assert.equal(h.pending(), undefined);
	});

	it("does not arm a turn that already sits outside its window", () => {
		const h = harness({ config: { enabled: true, windowMinutes: 60 } });
		const snapshot = h.snapshot();
		h.advance(60 * 60_000);
		const state = armForTurn({ piSessionId: "pi-1", model: SONNET, snapshot, promptTokens: BIG_PROMPT });
		assert.equal(h.pending(), undefined);
		assert.match(state.stopped, /window already elapsed/);
	});

	it("does not arm for a stale snapshot", () => {
		const h = harness({ deps: { isStale: () => true } });
		const state = h.arm();
		assert.equal(h.pending(), undefined);
		assert.match(state.stopped, /snapshot stale/);
	});

	it("re-arms shortly instead of probing while a real query is running", async () => {
		const h = harness();
		const state = h.arm();
		h.setQueryActive(true);
		await h.fire();
		assert.equal(h.replays.length, 0, "no probe while a real turn owns the session");
		assert.equal(h.pending().ms, WARM_BUSY_RETRY_MS);
		assert.equal(state.stopped, undefined, "the window is still alive");

		h.setQueryActive(false);
		h.advance(WARM_BUSY_RETRY_MS);
		await h.fire();
		assert.equal(h.replays.length, 1, "probes again once the turn is done");
	});

	it("reports each successful refresh with the window's run count", async () => {
		const h = harness({ config: { enabled: true, maxReplays: 3 } });
		const state = h.arm();
		await h.fire();
		assert.equal(h.refreshes.length, 1);
		assert.equal(h.refreshes[0].state, state);
		assert.equal(h.refreshes[0].state.replays, 1);
		assert.equal(h.refreshes[0].usage.cacheRead, state.promptTokens);
		h.advance(54 * 60_000);
		await h.fire();
		assert.equal(h.refreshes.length, 2, "the count climbs across a long absence");
		assert.equal(h.refreshes[1].state.replays, 2);
	});

	it("reports a stop with its reason, and not as a refresh", async () => {
		const h = harness({ usage: () => ({ cacheRead: 0, cacheWrite: 120_000, cacheWrite1h: 120_000 }) });
		h.arm();
		await h.fire();
		assert.equal(h.refreshes.length, 0, "a rewrite is not a refresh");
		assert.ok(h.stops.some((entry) => entry.reason.startsWith("prefix diverged")));
	});

	it("stops the window when the probe reads nothing back (prefix diverged)", async () => {		const h = harness({ usage: () => ({ cacheRead: 0, cacheWrite: 120_000, cacheWrite1h: 120_000 }) });
		const state = h.arm();
		await h.fire();
		assert.match(state.stopped, /prefix diverged/);
		assert.equal(h.pending(), undefined, "a rewrite is not worth repeating");
		assert.ok(h.logs.some((line) => line.includes("prefix diverged")));
	});

	it("stops when the probe reports no usage at all", async () => {
		const h = harness({ usage: () => undefined });
		const state = h.arm();
		await h.fire();
		assert.match(state.stopped, /no cache usage/);
		assert.equal(state.replays, 0, "an unmeasurable probe is not a refresh");
		assert.equal(h.pending(), undefined);
	});

	it("skips prompts below minPromptTokens before spending anything", () => {
		const h = harness({ config: { enabled: true, minPromptTokens: 50_000 } });
		const state = h.arm({ promptTokens: 12_000 });
		assert.equal(h.replays.length, 0);
		assert.equal(h.pending(), undefined);
		assert.match(state.stopped, /minPromptTokens/);
	});

	it("skips when the expected saving is below the threshold", async () => {
		const h = harness({ config: { enabled: true, minExpectedSavings: 100 } });
		const state = h.arm();
		await h.fire();
		assert.equal(h.replays.length, 0);
		assert.match(state.stopped, /expected savings/);
		assert.equal(h.pending(), undefined);
	});

	it("arms nothing while the feature is disabled", () => {
		const h = harness({ config: { enabled: false } });
		assert.equal(h.arm(), undefined);
		assert.deepEqual(warmStates(), []);
		assert.equal(h.pending(), undefined);
	});

	it("keys windows per (session, model), so a model switch keeps the other model's timer", async () => {
		const h = harness();
		const sonnet = h.arm({ model: SONNET });
		const opus = h.arm({ model: OPUS });
		assert.equal(warmStates().length, 2);
		assert.ok(sonnet.timer && !sonnet.timer.cleared, "the model switched away from stays armed");
		assert.ok(opus.timer && !opus.timer.cleared);
		const sonnetTimer = sonnet.timer;

		// Firing one model's refresh leaves the other model's timer alone.
		opus.timer.fn();
		await tick();
		assert.deepEqual(h.replays.map((state) => state.model), [OPUS]);
		assert.equal(sonnetTimer.cleared, false);

		cancelKey(sonnet.key, "switched away");
		assert.equal(sonnetTimer.cleared, true);
		assert.equal(sonnet.stopped, "switched away");
		assert.equal(sonnet.timer, undefined, "a cancelled window holds no timer");
		assert.equal(opus.timer.cleared, false);
		assert.equal(opus.stopped, undefined);
	});

	it("cancels one session's windows without touching another session's", () => {
		const h = harness();
		const a = h.arm({ piSessionId: "pi-a" });
		const b = h.arm({ piSessionId: "pi-b" });
		assert.equal(a.key, warmKey("pi-a", SONNET));
		assert.notEqual(a.key, b.key);
		const aTimer = a.timer;
		cancelSession("pi-a", "compaction");
		assert.equal(aTimer.cleared, true);
		assert.equal(a.stopped, "compaction");
		assert.equal(b.timer.cleared, false);
		assert.equal(b.stopped, undefined);
	});
});

describe("warm economics", () => {
	beforeEach(() => {
		cancelAll("test reset");
		configureWarmScheduler(undefined);
	});

	it("prices a refresh as a cache read plus one output token", () => {
		const economics = estimateWarmEconomics(PRICES.get(SONNET), 100_000, 0.3);
		assert.ok(Math.abs(economics.warmCost - (100_000 * 0.2 / 1e6 + 10 / 1e6)) < 1e-12);
		assert.ok(Math.abs(economics.missCost - 100_000 * (4 - 0.2) / 1e6) < 1e-12);
		assert.ok(Math.abs(economics.expectedSavings - (0.3 * economics.missCost - economics.warmCost)) < 1e-12);
	});

	it("has no economics for an unknown model or an empty prompt", () => {
		assert.equal(estimateWarmEconomics(undefined, 100_000, 0.3), undefined);
		assert.equal(estimateWarmEconomics(PRICES.get(SONNET), 0, 0.3), undefined);
	});

	it("reads the 1-hour write price as 2x input from the catalog", () => {
		const prices = warmPriceMap([
			{ id: "claude-sonnet-5-5", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
		]);
		assert.deepEqual(prices.get("claude-sonnet-5-5"), { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 });
	});
});

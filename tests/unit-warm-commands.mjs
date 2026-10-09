/**
 * /warm and /unwarm: the session-scoped override over cacheWarming.enabled.
 *
 * The observable the toggle actually flips is the cache_warming_decision veto —
 * the extension's answer to whether it owns warming — so these assert on that
 * rather than on the toast text alone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

const { __test } = await import("../src/index.js");

const BRIDGE_MODEL = { id: "claude-opus-5-5", baseUrl: "claude-bridge" };
const OTHER_MODEL = { id: "some-model", baseUrl: "openrouter" };
const SESSION = "pi-warm-commands-test";

function context(model, calls) {
	return {
		model,
		sessionManager: { getSessionId: () => SESSION, getBranch: () => [] },
		ui: { notify: (message, type) => calls.push({ message, type }) },
	};
}

const decision = (handlers) => handlers.get("cache_warming_decision")();

describe("warm commands", () => {
	it("refuses /warm on a non-claude-bridge model", async () => {
		__test.setOwnPiSessionId(SESSION);
		const handlers = activateWithMockPi();
		// Start from a known-disabled state so a global cacheWarming.enabled cannot
		// make the veto answer for the config rather than for this command.
		await handlers.commands.get("unwarm").handler("", context(BRIDGE_MODEL, []));

		const calls = [];
		await handlers.commands.get("warm").handler("", context(OTHER_MODEL, calls));

		assert.equal(calls.length, 1);
		assert.equal(calls[0].type, "warning");
		assert.match(calls[0].message, /only to claude-bridge models/);
		assert.equal(decision(handlers), undefined, "a refused /warm must not enable warming");
	});

	it("enables for the session and reports when the next probe is due", async () => {
		__test.setOwnPiSessionId(SESSION);
		const handlers = activateWithMockPi();
		// Start from a known-disabled state so the wording is the transition, not
		// whatever the developer's global claude-bridge.json happens to say.
		await handlers.commands.get("unwarm").handler("", context(BRIDGE_MODEL, []));

		const calls = [];
		await handlers.commands.get("warm").handler("", context(BRIDGE_MODEL, calls));

		assert.equal(calls.length, 1);
		assert.equal(calls[0].type, "info");
		assert.match(calls[0].message, /enabled for this session/);
		// No turn has run in this process, so no snapshot exists to arm from.
		assert.match(calls[0].message, /first probe ~\d+ min after the next turn/);
		assert.deepEqual(decision(handlers), { action: "stop" }, "the extension owns warming");
	});

	it("hands warming back to pi on /unwarm", async () => {
		__test.setOwnPiSessionId(SESSION);
		const handlers = activateWithMockPi();
		await handlers.commands.get("warm").handler("", context(BRIDGE_MODEL, []));
		assert.deepEqual(decision(handlers), { action: "stop" });

		const calls = [];
		await handlers.commands.get("unwarm").handler("", context(BRIDGE_MODEL, calls));

		assert.equal(calls.length, 1);
		assert.equal(calls[0].type, "info");
		assert.match(calls[0].message, /disabled for this session/);
		assert.equal(decision(handlers), undefined, "the veto is released once disabled");
	});
});

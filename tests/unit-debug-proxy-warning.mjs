/**
 * Regression test: the debugCaptureProxy TUI warning must only fire when a
 * claude-bridge model is actually active, not on every session_start
 * regardless of model (most sessions never spawn a CC child at all).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const DEBUG_CAPTURE_PROXY_KEY = Symbol.for("claude-bridge:debugCaptureProxy");

function setProxyEntry(entry) {
	globalThis[DEBUG_CAPTURE_PROXY_KEY] = entry;
}

describe("warnDebugCaptureProxyIfNeeded", () => {
	afterEach(() => {
		__test.setPiMode(null);
		__test.setPiUI(null);
		setProxyEntry(undefined);
	});

	it("does not warn when no claude-bridge model is active", () => {
		const notices = [];
		__test.setPiMode("tui");
		__test.setPiUI({ notify: (message, level) => notices.push({ message, level }) });
		setProxyEntry({ warned: false, proxy: { outDir: "/tmp/captures" } });

		__test.warnDebugCaptureProxyIfNeeded({ baseUrl: "anthropic" });
		__test.warnDebugCaptureProxyIfNeeded(undefined);

		assert.deepEqual(notices, []);
		assert.equal(globalThis[DEBUG_CAPTURE_PROXY_KEY].warned, false);
	});

	it("warns once when a claude-bridge model is active in a TUI session", () => {
		const notices = [];
		__test.setPiMode("tui");
		__test.setPiUI({ notify: (message, level) => notices.push({ message, level }) });
		setProxyEntry({ warned: false, proxy: { outDir: "/tmp/captures" } });

		__test.warnDebugCaptureProxyIfNeeded({ baseUrl: "claude-bridge" });
		__test.warnDebugCaptureProxyIfNeeded({ baseUrl: "claude-bridge" }); // second call: already warned

		assert.equal(notices.length, 1);
		assert.equal(notices[0].level, "warning");
		assert.match(notices[0].message, /\/tmp\/captures/);
		assert.equal(globalThis[DEBUG_CAPTURE_PROXY_KEY].warned, true);
	});

	it("does not warn outside a TUI session even on claude-bridge", () => {
		const notices = [];
		__test.setPiMode("json");
		__test.setPiUI({ notify: (message) => notices.push(message) });
		setProxyEntry({ warned: false, proxy: { outDir: "/tmp/captures" } });

		__test.warnDebugCaptureProxyIfNeeded({ baseUrl: "claude-bridge" });

		assert.deepEqual(notices, []);
	});

	it("is a no-op when the proxy is not running", () => {
		__test.setPiMode("tui");
		setProxyEntry(undefined);
		assert.doesNotThrow(() => __test.warnDebugCaptureProxyIfNeeded({ baseUrl: "claude-bridge" }));
	});
});

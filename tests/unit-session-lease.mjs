/**
 * Tests for the CC-session file lock (src/session-lease.ts):
 *   - acquireOrRefreshLease: create-or-refuse-or-reclaim semantics, gated on
 *     pid liveness rather than elapsed time.
 *   - releaseLease: only removes a lease this process actually owns.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOrRefreshLease, releaseLease } from "../src/session-lease.js";

const dir = mkdtempSync(join(tmpdir(), "claude-bridge-lease-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function lockPath() {
	return join(dir, `test-${n++}.lock`);
}

// A pid that is guaranteed dead: spawn a process and wait for it to exit.
function deadPid() {
	const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	return result.pid;
}

describe("acquireOrRefreshLease", () => {
	it("acquires an absent lease", () => {
		const p = lockPath();
		assert.equal(acquireOrRefreshLease(p, "owner-a"), true);
		const record = JSON.parse(readFileSync(p, "utf8"));
		assert.equal(record.pid, process.pid);
		assert.equal(record.ownerId, "owner-a");
	});

	it("refreshes a lease already held by this process (own pid)", () => {
		const p = lockPath();
		assert.equal(acquireOrRefreshLease(p, "owner-a"), true);
		assert.equal(acquireOrRefreshLease(p, "owner-b"), true);
		const record = JSON.parse(readFileSync(p, "utf8"));
		assert.equal(record.pid, process.pid);
		assert.equal(record.ownerId, "owner-b"); // refresh overwrites ownerId too
	});

	it("refuses a lease held by a live, foreign pid", () => {
		const p = lockPath();
		// process.pid 1 is init/launchd on POSIX systems and is always alive.
		writeFileSync(p, JSON.stringify({ pid: 1, ownerId: "someone-else", updatedAt: new Date().toISOString() }));
		assert.equal(acquireOrRefreshLease(p, "owner-a"), false);
		// Untouched — still shows the foreign owner.
		const record = JSON.parse(readFileSync(p, "utf8"));
		assert.equal(record.pid, 1);
	});

	it("reclaims a lease held by a dead pid", () => {
		const p = lockPath();
		writeFileSync(p, JSON.stringify({ pid: deadPid(), ownerId: "crashed", updatedAt: new Date().toISOString() }));
		assert.equal(acquireOrRefreshLease(p, "owner-a"), true);
		const record = JSON.parse(readFileSync(p, "utf8"));
		assert.equal(record.pid, process.pid);
		assert.equal(record.ownerId, "owner-a");
	});

	it("reclaims a lease with unreadable/corrupt contents", () => {
		const p = lockPath();
		writeFileSync(p, "not json");
		assert.equal(acquireOrRefreshLease(p, "owner-a"), true);
		const record = JSON.parse(readFileSync(p, "utf8"));
		assert.equal(record.pid, process.pid);
	});
});

describe("releaseLease", () => {
	it("removes a lease this process owns", () => {
		const p = lockPath();
		acquireOrRefreshLease(p, "owner-a");
		releaseLease(p);
		assert.equal(existsSync(p), false);
	});

	it("leaves a foreign lease untouched", () => {
		const p = lockPath();
		writeFileSync(p, JSON.stringify({ pid: 1, ownerId: "someone-else", updatedAt: new Date().toISOString() }));
		releaseLease(p);
		assert.equal(existsSync(p), true);
	});

	it("is a no-op on an absent lease", () => {
		const p = lockPath();
		assert.doesNotThrow(() => releaseLease(p));
	});
});

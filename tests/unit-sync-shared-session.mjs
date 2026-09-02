/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, getSessionPath, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");

describe("syncSharedSession", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
		__test.releaseHeldLease();
	});

	// The branch this exercises is the guard that stops a reentrant subagent from
	// resuming — and then overwriting — the parent's session: a subagent's context
	// is shorter than the parent's cursor, so it starts fresh and the parent's
	// session is preserved. It was previously described here as the compact-summary
	// path, which cannot reach syncSharedSession at all, so the branch read as
	// covered for a case that never happens.
	it("starts a fresh session for a shorter context and preserves the parent's", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(mainSession);

			const result = __test.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd);

			assert.equal(
				result.sessionId,
				null,
				"a context shorter than the cursor — a subagent, or AskClaude — must start a fresh Claude Code session instead of resuming the parent's",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh session must not replace the parent's when it completes",
			);
			assert.deepEqual(__test.getSharedSession(), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The rebuilt file holds one line per record, and a carried `@file` expansion
	// is an `attachment` record — which `session.messages` filters out. Counting
	// messages told every user who at-mentioned a file before switching providers
	// that their session was corrupt, and asked them to open an issue about it.
	it("does not report a count mismatch when a rebuild carries an attachment", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		const prompt = "Review @fixture.txt and remember it.";
		const notices = [];
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages(
				[
					{ role: "user", content: prompt },
					{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
				],
				{
					attachments: [{
						afterIndex: 0,
						attachment: {
							type: "file",
							filename: join(cwd, "fixture.txt"),
							content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
						},
					}],
				},
			);
			seeded.save();

			__test.setSharedSession({ sessionId, cursor: 0, cwd });
			__test.setPiUI({ notify: (message) => notices.push(message) });
			__test.syncSharedSession([
				{ role: "user", content: prompt, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
				{ role: "user", content: "Now what did it say?", timestamp: Date.now() },
			], cwd);

			assert.equal(
				openSession({ sessionId, projectPath: cwd }).attachments.length,
				1,
				"the rebuild did not carry the attachment, so this proves nothing about the count",
			);
			assert.deepEqual(notices, []);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// A sibling process (e.g. a /fork resuming shared history) can hold the
	// previous session's lease. Rebuilding must not delete or overwrite a file
	// someone else might still be writing to — it has to rotate to a fresh id
	// instead of preserving the old one.
	it("rotates to a fresh session id instead of preserving when the old id's lease is held elsewhere", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages([{ role: "user", content: "Hello" }]);
			seeded.save();

			// Simulate a live foreign holder: pid 1 (init/launchd) is always alive.
			const lockPath = `${getSessionPath(sessionId, cwd)}.lock`;
			writeFileSync(lockPath, JSON.stringify({ pid: 1, ownerId: "sibling", updatedAt: new Date().toISOString() }));

			// cursor: 0 so priorMessages (2 msgs) counts as fully "missed" rather than a
			// trailing-assistant continuation, routing into REBUILD instead of REUSE.
			__test.setSharedSession({ sessionId, cursor: 0, cwd });
			const result = __test.syncSharedSession([
				{ role: "user", content: "Hello", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Hi." }], timestamp: Date.now() },
				{ role: "user", content: "More.", timestamp: Date.now() },
			], cwd);

			assert.notEqual(result.sessionId, sessionId, "must not preserve an id whose lease is held elsewhere");
			assert.equal(existsSync(getSessionPath(sessionId, cwd)), true, "the still-locked file must not be deleted out from under its holder");
			assert.equal(existsSync(getSessionPath(result.sessionId, cwd)), true);
		} finally {
			deleteSession(sessionId, cwd);
			if (__test.getSharedSession()) deleteSession(__test.getSharedSession().sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("claims the lease for a freshly rebuilt session id", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const result = __test.syncSharedSession([
				{ role: "user", content: "Hello", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Hi." }], timestamp: Date.now() },
				{ role: "user", content: "More.", timestamp: Date.now() },
			], cwd);

			assert.equal(__test.getHeldLease()?.sessionId, result.sessionId);
			assert.equal(existsSync(`${getSessionPath(result.sessionId, cwd)}.lock`), true);
		} finally {
			const held = __test.getSharedSession();
			if (held) deleteSession(held.sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("recoverSharedSessionFromEntries", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.releaseHeldLease();
	});

	function fakeSessionManager(entries) {
		return { getBranch: () => entries };
	}

	it("returns null when no custom entry of our type exists", () => {
		const recovered = __test.recoverSharedSessionFromEntries(fakeSessionManager([
			{ type: "message", id: "1", parentId: null, timestamp: "t" },
		]), "/some/cwd");
		assert.equal(recovered, null);
	});

	it("recovers the latest custom entry's sessionId and cursor", () => {
		const recovered = __test.recoverSharedSessionFromEntries(fakeSessionManager([
			{ type: "custom", id: "1", parentId: null, timestamp: "t", customType: "claude-bridge:cc-session", data: { sessionId: "old-id", cursor: 2 } },
			{ type: "message", id: "2", parentId: "1", timestamp: "t" },
			{ type: "custom", id: "3", parentId: "2", timestamp: "t", customType: "claude-bridge:cc-session", data: { sessionId: "new-id", cursor: 4 } },
		]), "/some/cwd");
		assert.deepEqual(recovered, { sessionId: "new-id", cursor: 4, cwd: "/some/cwd", needsRebuild: false });
	});

	it("marks needsRebuild when a compaction happened after the last recorded pointer", () => {
		const recovered = __test.recoverSharedSessionFromEntries(fakeSessionManager([
			{ type: "custom", id: "1", parentId: null, timestamp: "t", customType: "claude-bridge:cc-session", data: { sessionId: "old-id", cursor: 2 } },
			{ type: "compaction", id: "2", parentId: "1", timestamp: "t", summary: "...", firstKeptEntryId: "1", tokensBefore: 100 },
		]), "/some/cwd");
		assert.deepEqual(recovered, { sessionId: "old-id", cursor: 2, cwd: "/some/cwd", needsRebuild: true });
	});

	it("ignores entries from a customType we don't own", () => {
		const recovered = __test.recoverSharedSessionFromEntries(fakeSessionManager([
			{ type: "custom", id: "1", parentId: null, timestamp: "t", customType: "some-other-extension", data: { sessionId: "nope", cursor: 99 } },
		]), "/some/cwd");
		assert.equal(recovered, null);
	});
});

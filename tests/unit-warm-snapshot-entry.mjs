/**
 * The warm snapshot a real turn persists into its own pi session
 * (`claude-bridge:warm-snapshot`). A pi-subagent child is a separate pi process,
 * so this entry is the only way its spawner can learn the request shape a warm
 * probe would have to reproduce. It must be written when the shape changes, not
 * on every turn, and only for this process's own session.
 *
 * Each test takes a fresh pi session id: the snapshot map is module state, so a
 * shared id would carry the previous test's shape into the next one.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const ENTRY = "claude-bridge:warm-snapshot";

let appended;
let seq = 0;
const ownSession = () => {
	const id = `pi-warm-snapshot-own-${++seq}`;
	__test.setOwnPiSessionId(id);
	return id;
};

const shape = (piSessionId, overrides = {}) => ({
	piSessionId,
	ccSessionId: "cc-session-1",
	cwd: "/tmp/proj",
	model: "claude-opus-5-5",
	cliModel: "claude-opus-5-5",
	effort: undefined,
	systemPromptAppend: "APPEND",
	mcpTools: [{ name: "read", description: "read a file", inputSchema: { type: "object" } }],
	...overrides,
});

beforeEach(() => {
	appended = [];
	__test.setExtensionApi({ appendEntry: (customType, data) => appended.push({ customType, data }) });
});

describe("warm snapshot session entry", () => {
	it("appends the request shape for the process's own pi session", () => {
		const session = ownSession();
		__test.recordWarmSnapshot(shape(session));

		assert.equal(appended.length, 1);
		assert.equal(appended[0].customType, ENTRY);
		assert.equal(appended[0].data.ccSessionId, "cc-session-1");
		assert.equal(appended[0].data.cwd, "/tmp/proj");
		assert.equal(appended[0].data.systemPromptAppend, "APPEND");
		assert.equal(appended[0].data.mcpTools.length, 1);
		assert.equal(typeof appended[0].data.at, "number");
	});

	it("skips turns that do not change the shape, and writes again when one does", () => {
		const session = ownSession();
		__test.recordWarmSnapshot(shape(session));
		__test.recordWarmSnapshot(shape(session));
		__test.recordWarmSnapshot(shape(session));
		assert.equal(appended.length, 1, "an unchanged request does not grow the session");

		__test.recordWarmSnapshot(shape(session, { effort: "high" }));
		assert.equal(appended.length, 2, "a changed effort is a different prefix");
		assert.equal(appended[1].data.effort, "high");

		__test.recordWarmSnapshot(shape(session, { effort: "high", systemPromptAppend: "APPEND2" }));
		assert.equal(appended.length, 3, "a changed append is a different prefix");
	});

	it("keeps the snapshot in memory but writes nothing for another pi session", () => {
		const session = `pi-somebody-else-${++seq}`;
		__test.setOwnPiSessionId(`pi-this-process-${++seq}`);
		__test.recordWarmSnapshot(shape(session));

		assert.equal(appended.length, 0, "a session this process does not own must not write here");
		assert.equal(__test.getWarmSnapshot(session, "claude-opus-5-5").ccSessionId, "cc-session-1");
	});
});

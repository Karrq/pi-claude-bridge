// File-based advisory lock guarding a single Claude Code session's JSONL
// against concurrent writers (e.g. two pi processes sharing history via
// /fork, or a second process resuming the same pi session). One lock file
// per CC session, living next to that session's JSONL as `<path>.lock`.
//
// Staleness is decided by pid liveness, not elapsed time: a lease is valid
// for exactly as long as its owning process is alive, however long that
// turns out to be (a slow tool call is not distinguishable from a fast one
// from outside the process, so there is no safe fixed window to pick). A
// wrong liveness read only ever makes acquisition too conservative — it
// never causes two processes to both believe they hold the same lease — so
// pid reuse is an accepted, bounded risk: worst case is a missed reuse of a
// still-warm cache, not a corrupted session file.

import { readFileSync, unlinkSync, writeFileSync } from "fs";

interface LeaseRecord {
	pid: number;
	ownerId: string;
	updatedAt: string;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		// ESRCH: no such process. Anything else (e.g. EPERM, owned by another
		// user) means it exists but we can't signal it — treat as alive.
		return error?.code !== "ESRCH";
	}
}

function readLease(lockPath: string): LeaseRecord | null {
	try {
		return JSON.parse(readFileSync(lockPath, "utf8"));
	} catch {
		return null; // missing, or corrupt — treated as abandoned
	}
}

/**
 * Acquire the lease at `lockPath`, or refresh it if this process already
 * holds it. Returns false if a different, live process holds it.
 *
 * The create attempt is atomic (`wx`); reclaiming an abandoned lease
 * (dead or unreadable) unlinks it and retries the same atomic create, so
 * two processes racing to reclaim the same dead lease can't both succeed —
 * exactly one atomic create wins, and the loser sees the winner's live pid
 * on its next read.
 */
export function acquireOrRefreshLease(lockPath: string, ownerId: string): boolean {
	const record: LeaseRecord = { pid: process.pid, ownerId, updatedAt: new Date().toISOString() };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(lockPath, JSON.stringify(record), { flag: "wx" });
			return true;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
		}
		const existing = readLease(lockPath);
		if (existing?.pid === process.pid) {
			writeFileSync(lockPath, JSON.stringify(record)); // ours already — refresh
			return true;
		}
		if (existing && isPidAlive(existing.pid)) return false; // live, foreign
		try {
			unlinkSync(lockPath); // dead or unreadable — clear it and retry the atomic create
		} catch {
			// Already gone, or another reclaimer beat us to the unlink — fine,
			// the retry's atomic create is what actually decides the winner.
		}
	}
	return false; // lost two atomic-create races in a row — be conservative
}

/** Release the lease at `lockPath` if this process still holds it. */
export function releaseLease(lockPath: string): void {
	const existing = readLease(lockPath);
	if (existing?.pid === process.pid) {
		try {
			unlinkSync(lockPath);
		} catch {
			// Already gone — nothing to do.
		}
	}
}

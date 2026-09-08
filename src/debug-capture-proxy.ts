// In-process recording proxy for Claude Code's outbound API traffic, wired
// through `provider.debugCaptureProxy` in config.ts. Every CC child gets
// ANTHROPIC_BASE_URL pointed at this server via CC_CHILD_ENV so requests are
// transparently forwarded and recorded on the way through.
//
// Mirrors the standalone `diag/capture-proxy.mjs` (dev-only, not shipped —
// see package.json "files") closely enough that `diag/diff-captures.mjs`
// works unmodified against either output. Keep the capture shape (index.jsonl
// fields, req-NNNN.json/err-NNNN.json naming) in sync if either one changes.
//
// Captures contain full conversation content and are written to disk
// unencrypted. This exists for debugging prompt-cache behavior, not for
// routine use — off by default, and the extension warns once per process
// when it's on.

import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface DebugCaptureProxyHandle {
	outDir: string;
	close(): void;
}

/** Header set minus credential material. `authorization` is reduced to its key
 *  family so a capture still shows whether a request authenticated as a
 *  subscription (oat) or an API key (api), which changes how it is billed. */
function safeHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (k === "authorization") out[k] = `${v.split(" ")[0]} ${v.split(" ")[1]?.slice(0, 12) ?? ""}…`;
		else if (k === "x-api-key") out[k] = `${v.slice(0, 12)}…`;
		else out[k] = v;
	}
	return out;
}

interface CaptureUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number | undefined;
	cacheWrite5m: number | undefined;
}

/** cache_read/cache_creation off the SSE stream, so each captured request is
 *  paired with what the cache actually did for it. cacheWrite1h/cacheWrite5m
 *  are undefined (not 0) when the response has no cache_creation breakdown at
 *  all, which distinguishes "wrote 0 to the 1h bucket" from "no TTL info". */
function usageFromSse(text: string): CaptureUsage | null {
	const start = text.match(/^data: (\{"type":"message_start".*)$/m);
	if (!start) return null;
	try {
		const usage = JSON.parse(start[1]).message?.usage ?? {};
		return {
			input: usage.input_tokens ?? 0,
			cacheRead: usage.cache_read_input_tokens ?? 0,
			cacheWrite: usage.cache_creation_input_tokens ?? 0,
			cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens,
			cacheWrite5m: usage.cache_creation?.ephemeral_5m_input_tokens,
		};
	} catch {
		return null;
	}
}

function headerRecord(headers: IncomingMessage["headers"]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
	return out;
}

/** Starts the proxy and returns immediately; `onReady` fires once the OS has
 *  assigned a port, since a caller may need to hand out ANTHROPIC_BASE_URL to
 *  child processes started before that happens. Forwards to whatever upstream
 *  Claude Code would otherwise use (a pre-existing ANTHROPIC_BASE_URL —
 *  Bedrock, Vertex, a corporate proxy — takes precedence over the real API),
 *  so enabling this never changes where traffic actually goes. */
export function startDebugCaptureProxy(outDir: string, onReady: (url: string) => void): DebugCaptureProxyHandle {
	const upstream = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
	mkdirSync(outDir, { recursive: true });
	const index = join(outDir, "index.jsonl");
	let seq = 0;

	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", async () => {
			const body = Buffer.concat(chunks);
			const n = ++seq;

			const headers = headerRecord(req.headers);
			delete headers.host;
			delete headers["content-length"];
			delete headers["accept-encoding"]; // keep the response readable for usage parsing

			let upstreamRes: Response;
			try {
				upstreamRes = await fetch(`${upstream}${req.url}`, {
					method: req.method,
					headers,
					body: req.method && ["GET", "HEAD"].includes(req.method) ? undefined : body,
				});
			} catch (error) {
				res.writeHead(502).end(String((error as Error).message));
				return;
			}

			const text = await upstreamRes.text();
			const responseHeaders: Record<string, string> = {};
			for (const [k, v] of upstreamRes.headers) if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) responseHeaders[k] = v;
			res.writeHead(upstreamRes.status, responseHeaders).end(text);

			let parsed: { model?: string; messages?: unknown[]; tools?: unknown[] } | null = null;
			try { parsed = JSON.parse(body.toString("utf8")); } catch { /* not JSON, e.g. a HEAD probe */ }
			if (parsed) writeFileSync(join(outDir, `req-${String(n).padStart(4, "0")}.json`), JSON.stringify(parsed, null, 1));

			const requestHeaders = safeHeaders(headers);
			if (upstreamRes.status >= 300 && req.url?.startsWith("/v1/")) {
				writeFileSync(join(outDir, `err-${String(n).padStart(4, "0")}.json`), JSON.stringify({
					n, at: new Date().toISOString(), status: upstreamRes.status, path: req.url,
					requestHeaders, responseHeaders, responseBody: text,
				}, null, 1));
			}

			appendFileSync(index, JSON.stringify({
				n,
				at: new Date().toISOString(),
				path: req.url,
				status: upstreamRes.status,
				model: parsed?.model,
				messages: parsed?.messages?.length ?? null,
				tools: parsed?.tools?.length ?? null,
				usage: usageFromSse(text),
				betas: requestHeaders["anthropic-beta"] ?? null,
				auth: requestHeaders.authorization ?? requestHeaders["x-api-key"] ?? null,
			}) + "\n");
		});
	});

	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		onReady(`http://127.0.0.1:${port}`);
	});
	// A debug listener must never be the reason a process stays alive. Without this
	// the socket holds the event loop open until something calls close(), so an
	// embedder that activates the extension without ever emitting session_shutdown
	// — a unit test, most concretely — hangs at exit with the capture enabled.
	// Nothing is lost by exiting on an idle proxy: an in-flight capture implies an
	// in-flight query, whose own handles keep the loop alive on their own.
	server.unref();

	return { outDir, close: () => server.close() };
}

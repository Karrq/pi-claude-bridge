#!/usr/bin/env node
// Probe: how does CC surface an API failure to the SDK stream, and does a
// healthy turn ever look the same?
//
// Run 1 points ANTHROPIC_BASE_URL at a local server that answers every request
// with a 429. Run 2 is the control: the same query against the real API. Both
// dump every SDK message with its type, model marker, and content, so the shape
// CC fabricates for a failure — and the absence of that shape on a healthy turn
// — is visible rather than assumed.
//
// Run: node diag/probe-synthetic-error.mjs

import { createServer } from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";

const MODEL = "claude-haiku-4-5";

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		if (req.url?.includes("count_tokens")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ input_tokens: 10 }));
			return;
		}
		res.writeHead(429, { "content-type": "application/json" });
		res.end(JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "You're out of extra usage · resets 6:30pm" },
		}));
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function run(label, extraEnv) {
	const messages = [];
	try {
		for await (const message of query({
			prompt: "Reply with just: OK",
			options: {
				cwd: process.cwd(),
				model: MODEL,
				tools: [],
				permissionMode: "bypassPermissions",
				includePartialMessages: true,
				maxTurns: 1,
				persistSession: false,
				extraArgs: { "strict-mcp-config": null },
				env: {
					...process.env,
					ENABLE_CLAUDEAI_MCP_SERVERS: "0",
					DISABLE_AUTO_COMPACT: "1",
					...extraEnv,
				},
			},
		})) {
			messages.push(message);
		}
	} catch (err) {
		console.log(`[${label}] query threw:`, err?.message ?? err);
	}
	return messages;
}

const failed = await run("429", { ANTHROPIC_BASE_URL: baseUrl });
server.close();
const succeeded = await run("control", {});

for (const [label, messages] of [["429 (mocked API failure)", failed], ["control (real API, healthy turn)", succeeded]]) {
console.log(`\n=== ${label}: ${messages.length} SDK messages ===\n`);
for (const m of messages) {
	if (m.type === "stream_event") {
		const ev = m.event ?? {};
		const detail = ev.type === "message_start" ? ` model=${JSON.stringify(ev.message?.model)}`
			: ev.type === "content_block_delta" ? ` delta=${JSON.stringify(ev.delta?.text ?? ev.delta?.thinking ?? "")}`
			: "";
		console.log(`stream_event  ${ev.type}${detail}`);
		continue;
	}
	if (m.type === "assistant") {
		console.log(`assistant     model=${JSON.stringify(m.message?.model)}`);
		console.log(`              msgKeys=${JSON.stringify(Object.keys(m))}`);
		console.log(`              error=${JSON.stringify(m.error)}`);
		console.log(`              stop_reason=${JSON.stringify(m.message?.stop_reason)} stop_details=${JSON.stringify(m.message?.stop_details)}`);
		for (const block of m.message?.content ?? []) {
			console.log(`              block ${block.type}: ${JSON.stringify(String(block.text ?? "").slice(0, 160))}`);
		}
		continue;
	}
	if (m.type === "result") {
		console.log(`result        subtype=${m.subtype} is_error=${m.is_error} api_error_status=${m.api_error_status}`);
		console.log(`              result=${JSON.stringify(String(m.result ?? "").slice(0, 200))}`);
		continue;
	}
	console.log(`${m.type.padEnd(13)} ${JSON.stringify(m).slice(0, 200)}`);
}
}

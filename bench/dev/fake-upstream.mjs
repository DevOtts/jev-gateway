#!/usr/bin/env node
// A stand-in Responses API provider for testing the benchmark itself. It streams a reply whose
// token usage depends on whether the gateway forced a tool, so a run shows a visible difference.
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_UPSTREAM_PORT ?? 8798);
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const steered = typeof JSON.parse(body || "{}").tool_choice !== "string";
    const usage = {
      input_tokens: 12000,
      input_tokens_details: { cached_tokens: 9000 },
      output_tokens: steered ? 80 : 400,
      output_tokens_details: { reasoning_tokens: steered ? 30 : 340 },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n`);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`fake upstream on http://127.0.0.1:${PORT}/v1`));

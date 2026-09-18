import { serve } from "@hono/node-server";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

// Reads TYPESAFE_API_KEY. One fast retry only: past that, failing open to the LLM is quicker.
const jev = new TypeSafeClient({
  defaultModel: config.jevModel,
  timeout: config.jevTimeoutMs,
  retry: { maxRetries: 1, backoffInitialMs: 100 },
});

const app = createApp({
  config,
  askJev: (request) => jev.systemOne(request),
  log: (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry })),
});

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`jev-router listening on http://localhost:${port} → ${config.upstreamBaseUrl} (jev: ${config.jevModel})`);
});

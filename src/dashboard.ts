import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Config } from "./config.js";
import type { EventLog } from "./events.js";

// A real .html file rather than a string in a module, so it stays editable as HTML; `pnpm build`
// copies it next to the compiled output.
const page = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

/**
 * jev-codex and jev-claude each run their own router, and one page should show both: a dashboard
 * served by one router polls the others. Only a page that itself came from this machine may read
 * across ports — any other origin gets no CORS header, so the browser withholds the response.
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function dashboardRoutes(config: Config, events: EventLog) {
  const startedAt = new Date().toISOString();
  const routes = new Hono();

  routes.get("/", (c) => c.html(page));

  routes.get("/events", (c) => {
    const origin = c.req.header("origin");
    if (origin && LOCAL_ORIGIN.test(origin)) {
      c.header("access-control-allow-origin", origin);
      c.header("vary", "origin");
    }
    c.header("cache-control", "no-store");
    const since = Number(c.req.query("since") ?? 0);
    return c.json({
      router: {
        client: config.client,
        upstream: config.upstreamBaseUrl,
        jevModel: config.jevModel,
        minConfidence: config.minConfidence,
        // Sequence numbers restart with the process: a page that sees this change starts over.
        startedAt,
        now: new Date().toISOString(),
        recorded: events.last,
      },
      events: events.since(Number.isFinite(since) ? since : 0),
    });
  });

  return routes;
}

import { timingSafeEqual } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { Hono, type Context } from "hono";
import type { Adapter } from "./adapters/adapter.js";
import { chatAdapter } from "./adapters/chat.js";
import { messagesAdapter } from "./adapters/messages.js";
import { responsesAdapter } from "./adapters/responses.js";
import type { Config } from "./config.js";
import { decide, type AskJev, type Decision } from "./decide.js";
import { forward } from "./upstream.js";

export interface Deps {
  config: Config;
  askJev: AskJev;
  /** Upstream transport; defaults to global fetch. */
  fetch?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
}

type AnyRequest = { model?: string; stream?: boolean; tools?: unknown[] };

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const DECODERS: Record<string, (data: Uint8Array) => Buffer> = {
  zstd: zstdDecompressSync,
  gzip: gunzipSync,
  br: brotliDecompressSync,
  deflate: inflateSync,
};

/** Parse a JSON body, undoing request compression (Codex sends zstd). Undefined if unreadable. */
function parseBody<Req>(bytes: Uint8Array, encoding: string | undefined): Req | undefined {
  try {
    const decoder = encoding ? DECODERS[encoding.trim().toLowerCase()] : undefined;
    if (encoding && !decoder) return undefined;
    const parsed: unknown = JSON.parse(Buffer.from(decoder ? decoder(bytes) : bytes).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Req) : undefined;
  } catch {
    return undefined;
  }
}

function decisionHeaders(decision: Decision): Record<string, string> {
  const headers: Record<string, string> = { "x-jev-router-mode": decision.mode };
  if (decision.mode === "passthrough") headers["x-jev-router-reason"] = decision.reason.slice(0, 120);
  if (decision.mode === "forced" || decision.mode === "direct" || decision.mode === "hint") {
    headers["x-jev-router-tool"] = decision.tool;
  }
  if (decision.jev) {
    headers["x-jev-router-confidence"] = decision.jev.confidence.toFixed(3);
    headers["x-jev-router-latency-ms"] = String(decision.jev.latencyMs);
  }
  return headers;
}

export function createApp({ config, askJev, fetch: fetchImpl = fetch, log = () => {} }: Deps) {
  const app = new Hono();

  const decideFor = <Req extends AnyRequest>(adapter: Adapter<Req>, req: Req): Promise<Decision> | Decision => {
    const input = adapter.toInput(req, config.maxMessageChars);
    return "skip" in input ? { mode: "passthrough", reason: input.skip } : decide(input, config, askJev);
  };

  const route = <Req extends AnyRequest>(adapter: Adapter<Req>) => async (c: Context) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    // Unreadable bodies are not ours to judge: upstream produces its own error for them.
    const req = parseBody<Req>(bytes, c.req.header("content-encoding"));

    let decision: Decision = !req
      ? { mode: "passthrough", reason: "unparseable_body" }
      : c.req.header("x-jev-router") === "off"
        ? { mode: "passthrough", reason: "disabled_by_header" }
        : await decideFor(adapter, req);

    const entry = { event: "route", path: c.req.path, model: req?.model, tools: req?.tools?.length ?? 0 };
    if (req && decision.mode === "direct") {
      log({ ...entry, ...decision });
      const call = { tool: decision.tool, args: decision.args, inputTokens: decision.jev?.inputTokens ?? 0 };
      const headers = decisionHeaders(decision);
      return req.stream
        ? c.body(adapter.directStream(req, call), 200, {
            ...headers,
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          })
        : c.json(adapter.directJson(req, call), 200, headers);
    }

    if (req && decision.mode !== "passthrough") {
      const body = JSON.stringify(adapter.apply(req, decision, config.argsModel));
      const response = await forward(c.req.raw, config, fetchImpl, { body, responseHeaders: decisionHeaders(decision) });
      if (response.status !== 400 && response.status !== 422) {
        log({ ...entry, ...decision, status: response.status });
        return response;
      }
      // The upstream refused the rewritten request (some backends only accept tool_choice
      // "auto"): the router must never be the reason a request fails, so replay the original.
      await response.body?.cancel();
      decision = { mode: "passthrough", reason: `upstream_rejected_${decision.mode}`, jev: decision.jev };
    }

    const response = await forward(c.req.raw, config, fetchImpl, {
      body: bytes,
      responseHeaders: decisionHeaders(decision),
    });
    log({ ...entry, ...decision, status: response.status });
    return response;
  };

  app.get("/health", (c) => c.json({ status: "ok", upstream: config.upstreamBaseUrl }));

  app.use("*", async (c, next) => {
    if (!config.routerApiKey) return next();
    const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (safeEqual(presented, config.routerApiKey)) return next();
    return c.json({ error: { message: "Invalid jev-router API key", type: "invalid_api_key" } }, 401);
  });

  /**
   * Dry run: what would the router do with this body? Calls Jev, never upstream.
   * Accepts any routed wire format; `?format=chat|responses|messages` overrides the guess.
   */
  app.post("/router/decide", async (c) => {
    const req = parseBody<Record<string, unknown>>(new Uint8Array(await c.req.arrayBuffer()), undefined);
    if (!req) return c.json({ error: { message: "Body must be a JSON object", type: "invalid_request_error" } }, 400);
    const adapters = { chat: chatAdapter, responses: responsesAdapter, messages: messagesAdapter };
    // Chat Completions and Anthropic Messages both use `messages`; only Anthropic has a top-level
    // `system` or tools described by `input_schema`.
    const tools = Array.isArray(req.tools) ? (req.tools as Record<string, unknown>[]) : [];
    const guess = !("messages" in req)
      ? "responses"
      : "system" in req || tools.some((tool) => "input_schema" in tool)
        ? "messages"
        : "chat";
    const format = (c.req.query("format") ?? guess) as keyof typeof adapters;
    const adapter = (adapters[format] ?? adapters[guess]) as Adapter<AnyRequest>;
    return c.json(await decideFor(adapter, req));
  });

  app.post("/v1/chat/completions", route(chatAdapter));
  app.post("/v1/responses", route(responsesAdapter));
  app.post("/v1/messages", route(messagesAdapter));

  // Everything else (models, embeddings, …) is proxied untouched.
  app.all("/v1/*", (c) => forward(c.req.raw, config, fetchImpl));

  return app;
}

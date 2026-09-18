import type { Config } from "./config.js";

// Hop-by-hop and length/encoding headers must not cross the proxy: fetch re-frames
// (and transparently decompresses) bodies, so the originals would be wrong.
const DROPPED_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding"]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "content-length", "content-encoding", "transfer-encoding"]);

export interface ForwardOptions {
  /**
   * Body to send instead of streaming the incoming one: the original bytes (already consumed
   * for routing), or a rewritten JSON string — which is never compressed, whatever came in.
   */
  body?: string | Uint8Array;
  /** Headers added to the response so callers can see what the router did. */
  responseHeaders?: Record<string, string>;
}

/** Proxy a gateway request (`/v1/...`) to the upstream API, streaming the response back. */
export async function forward(
  incoming: Request,
  config: Config,
  fetchImpl: typeof fetch,
  options: ForwardOptions = {},
): Promise<Response> {
  const url = new URL(incoming.url);
  const target = config.upstreamBaseUrl + url.pathname.replace(/^\/v1/, "") + url.search;

  const headers = new Headers();
  incoming.headers.forEach((value, name) => {
    if (!DROPPED_REQUEST_HEADERS.has(name) && !name.startsWith("x-jev-")) headers.set(name, value);
  });
  if (config.upstreamApiKey) headers.set("authorization", `Bearer ${config.upstreamApiKey}`);
  if (typeof options.body === "string") headers.delete("content-encoding");

  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method: incoming.method, headers, signal: incoming.signal };
  if (options.body !== undefined) {
    init.body = options.body as BodyInit;
  } else if (hasBody && incoming.body) {
    init.body = incoming.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: { message: `jev-router could not reach upstream: ${message}`, type: "upstream_unreachable" } },
      { status: 502, headers: options.responseHeaders },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders.set(name, value);
  });
  for (const [name, value] of Object.entries(options.responseHeaders ?? {})) responseHeaders.set(name, value);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

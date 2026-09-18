# jev-router

An OpenAI-compatible LLM gateway (Chat Completions + Responses API). Point your client — or Codex — at it instead of your LLM provider; whenever a
request is really asking **"which tool should I call?"**, the router hands that decision to
[Jev](https://docs.typesafe.ai/introduction) — TypeSafe's System One model — instead of paying a
reasoning LLM to make it.

Jev doesn't generate text. It answers typed questions (Choice / Score / Noul) about a piece of
state and returns calibrated probabilities plus a confidence, in one fast call. Tool selection is
exactly that kind of question, so the split is:

| Decision | Who makes it |
| --- | --- |
| Which tool, or no tool at all | **Jev** (Choice over the tool list + a Noul cross-check) |
| Arguments that are enums / booleans / consts | **Jev** (fanned out in the same call) |
| Open-ended arguments (free text, numbers, dates) | Upstream LLM, with `tool_choice` forced to Jev's pick |
| Plain text replies, everything without `tools` | Upstream LLM, untouched |

## How a request is routed

`POST /v1/chat/completions` with `tools` and `tool_choice` of `auto`/`required` triggers **one**
Jev call. The conversation becomes the state; the questions are:

- `tool` — Choice: every tool name → its description, plus `no_tool_needed` (omitted for `required`)
- `needs_tool` — Noul: an independent "does the assistant need a tool now?" check
- `arg:*` / `stated:*` — for each tool whose parameters are *all* closed-set, one question per
  argument (and "was it stated?" for optional ones), asked speculatively since extra questions are
  nearly free

The answer picks one of four modes, reported in the `x-jev-router-mode` response header:

| Mode | When | What happens |
| --- | --- | --- |
| `direct` | Tool is confident and every argument is closed-set and certain | The router synthesizes the `tool_calls` response itself (streaming included). **No LLM call.** |
| `forced` | Tool is confident, arguments need an LLM | Forwarded with `tool_choice` set to that function — and to `ARGS_MODEL` if configured, since the hard part is already done |
| `none` | Jev is confident no tool is needed | Forwarded with `tool_choice: "none"` (or untouched with `JEV_ON_NONE=passthrough`) |
| `passthrough` | Low confidence, the two questions disagree, Jev errored/timed out, no tools, caller already chose | Forwarded byte-for-byte; `x-jev-router-reason` says why |

The router always **fails open**: any Jev problem means the LLM decides, as if the gateway weren't
there. All other `/v1/*` routes (models, embeddings, …) are proxied unchanged.

## Run it

```bash
pnpm install
cp .env.example .env    # set TYPESAFE_API_KEY, and UPSTREAM_BASE_URL if not OpenAI
pnpm dev
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1")  # your usual provider key still works
```

By default the client's own `Authorization` header is forwarded upstream. Set `UPSTREAM_API_KEY`
to have the gateway hold the provider key, and `ROUTER_API_KEY` to require a gateway key from
clients. Any OpenAI-compatible upstream works (OpenAI, OpenRouter, vLLM, Ollama, LiteLLM, …).

### Try a decision without an upstream

`POST /router/decide` takes a chat.completions body, calls Jev, and returns the decision — mode,
tool, arguments, Jev's confidence, top probabilities, tokens and latency — without calling the LLM:

```bash
curl -s localhost:8787/router/decide -H 'content-type: application/json' -d '{
  "model": "gpt-5",
  "messages": [{"role": "user", "content": "turn the kitchen lights on"}],
  "tools": [{"type": "function", "function": {
    "name": "set_lights", "description": "Turn the lights in a room on or off.",
    "parameters": {"type": "object", "required": ["room", "on"], "properties": {
      "room": {"type": "string", "enum": ["kitchen", "bedroom", "office"]},
      "on": {"type": "boolean"}}}}}]
}'
```

Send `x-jev-router: off` on any request to bypass Jev for that call.

## Use it with Codex (local)

Codex only speaks the Responses API, so the router handles `POST /v1/responses` the same way as
chat completions — including Codex's free-form tools (`apply_patch`), provider-run tools
(`web_search`, offered to Jev but never forced) and zstd-compressed request bodies.

```bash
npm link                 # once, puts `jev-codex` on your PATH (or use `pnpm codex -- …`)
jev-codex                # instead of `codex`; every codex argument still works
jev-codex exec "fix the failing test"
jev-codex --jev-logs     # second terminal: watch each routing decision live
```

`jev-codex` starts a background router on `127.0.0.1:8790` if one isn't running, then launches
`codex` with a `-c model_providers.jev-router…` override. **Nothing in `~/.codex` is modified**, and
plain `codex` keeps working as before. It reuses your existing Codex login
(`requires_openai_auth = true`): with a ChatGPT subscription the router forwards to
`https://chatgpt.com/backend-api/codex`, with an API key to `https://api.openai.com/v1`
(override with `JEV_CODEX_UPSTREAM_BASE_URL`). `TYPESAFE_API_KEY` is read from the environment or
this repo's `.env`. `jev-codex --jev-help` lists the rest (`--jev-status`, `--jev-stop`,
`--jev-config` for a permanent `codex --profile jev`).

If the upstream rejects a rewritten request (HTTP 400/422 — some backends only accept
`tool_choice: "auto"`), the router replays the original, so Codex never sees a router-caused error.

## Configuration

See [.env.example](.env.example). The ones worth tuning:

- `JEV_MIN_CONFIDENCE` (0.7) — below this the LLM decides. Raise it to be more conservative.
- `JEV_ARG_MIN_CERTAINTY` (0.8) — the weakest argument must clear this for a `direct` answer;
  otherwise the request degrades to `forced`.
- `ARGS_MODEL` — a cheap model for argument filling in `forced` mode.
- `JEV_DIRECT_CALLS=false` — never answer without the LLM; Jev only picks the tool.

Each routed request logs one JSON line (mode, reason, Jev's choice/confidence/latency) to stdout.

## Known trade-offs

- Jev picks **one** tool per turn. In `forced` mode the LLM can still call that tool several times
  in parallel, but not mix different tools in one turn; `direct` mode emits exactly one call.
- Jev is text-only with a 32k-token state budget: images become `[image_url]` placeholders and long
  conversations keep their newest turns (`JEV_MAX_STATE_CHARS`). It is most accurate in English.
- Chat Completions and the Responses API are routed. The Anthropic Messages format is not — adding
  it means one more adapter in `src/adapters/`.

## Layout

```
src/adapters/      wire formats ↔ neutral shapes: chat.ts (Chat Completions), responses.ts (Responses/Codex)
src/state.ts       conversation → Jev state (truncation, newest-turns budget)
src/questions.ts   tools → Jev questions; detects closed-set parameters
src/decide.ts      the Jev call and the mode decision
src/upstream.ts    streaming reverse proxy
src/app.ts         Hono app: routes, auth, headers, fail-open replay
bin/jev-codex.mjs  Codex launcher
```

`pnpm test` runs the suite against fake Jev and upstream transports; no keys needed.

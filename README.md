# jev-gateway

> Independent project — not affiliated with or endorsed by TypeSafe. "Jev" is TypeSafe's model; this
> gateway is a client of its public API.

An LLM gateway that speaks Chat Completions, the Responses API and the Anthropic Messages API.
Point your client — or Codex, or Claude Code — at it instead of your LLM provider; whenever a
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

The answer picks one of five modes, reported in the `x-jev-gateway-mode` response header:

| Mode | When | What happens |
| --- | --- | --- |
| `direct` | Tool is confident and every argument is closed-set and certain | The router synthesizes the `tool_calls` response itself (streaming included). **No LLM call.** |
| `forced` | Tool is confident, arguments need an LLM | Forwarded with `tool_choice` set to that function — and to `ARGS_MODEL` if configured, since the hard part is already done |
| `hint` | Tool is confident, but `tool_choice` can't be rewritten (Anthropic: extended thinking on, or the conversation is prompt-cached) | Forwarded with a one-line suggestion appended *after* the client's last block, so cached prefixes stay intact. The LLM may disagree |
| `none` | Jev is confident no tool is needed | Forwarded with `tool_choice: "none"` (or untouched with `JEV_ON_NONE=passthrough`) |
| `passthrough` | Low confidence, the two questions disagree, Jev errored/timed out, no tools, caller already chose | Forwarded byte-for-byte; `x-jev-gateway-reason` says why |

Rosters over 120 tools (Claude Code sends ~280) don't fit one good question, so they take two Jev
calls: every shard of the roster is ranked in one call, and the top 3 of each go on to the decision
above with full-length descriptions.

The router always **fails open**: any Jev problem means the LLM decides, as if the gateway weren't
there. All other `/v1/*` routes (models, embeddings, …) are proxied unchanged.

## Install

```bash
npm install -g jev-gateway
mkdir -p ~/.jev-gateway && echo "TYPESAFE_API_KEY=…" > ~/.jev-gateway/.env
jev-codex        # or: jev-claude
```

That is all the two launchers need (details below). To run the gateway as a standalone server for
your own clients, work from a checkout:

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

Send `x-jev-gateway: off` on any request to bypass Jev for that call.

## Use it with Codex (local)

Codex only speaks the Responses API, so the router handles `POST /v1/responses` the same way as
chat completions — including Codex's free-form tools (`apply_patch`), provider-run tools
(`web_search`, offered to Jev but never forced) and zstd-compressed request bodies.

```bash
jev-codex                # instead of `codex`; every codex argument still works
jev-codex exec "fix the failing test"
jev-codex --jev-logs     # second terminal: watch each routing decision live
```

`jev-codex` starts a background router on `127.0.0.1:8790` if one isn't running, then launches
`codex` with a `-c model_providers.jev-gateway…` override. **Nothing in `~/.codex` is modified**, and
plain `codex` keeps working as before. It reuses your existing Codex login
(`requires_openai_auth = true`): with a ChatGPT subscription the router forwards to
`https://chatgpt.com/backend-api/codex`, with an API key to `https://api.openai.com/v1`
(override with `JEV_CODEX_UPSTREAM_BASE_URL`). `TYPESAFE_API_KEY` is read from the environment,
`~/.jev-gateway/.env`, or a checkout's own `.env`. `jev-codex --jev-help` lists the rest (`--jev-status`, `--jev-stop`,
`--jev-config` for a permanent `codex --profile jev`).

If the upstream rejects a rewritten request (HTTP 400/422 — some backends only accept
`tool_choice: "auto"`), the router replays the original, so Codex never sees a router-caused error.

## Use it with Claude Code (local)

```bash
jev-claude               # instead of `claude`; every claude argument still works
jev-claude -p "summarise this repo"
jev-claude --jev-logs    # second terminal: watch each routing decision live
```

`jev-claude` starts a background router on `127.0.0.1:8789` forwarding to `https://api.anthropic.com/v1`
and runs `claude` with only `ANTHROPIC_BASE_URL` set. With no gateway credential alongside it, Claude
Code keeps using its saved login, so a **claude.ai subscription keeps working** and its limits apply
as usual; **nothing in `~/.claude` is modified**. The same `--jev-*` flags as `jev-codex` apply.

What Jev can do here is narrower than with Codex, by design of the API rather than the router:
Claude Code runs with adaptive thinking (a forced `tool_choice` is rejected) and re-reads a cached
conversation every turn (any `tool_choice` change would invalidate it). So Claude Code requests are
steered with `hint` mode, `none` is never applied, and `direct` still answers without the LLM when
a tool's arguments are all closed-set. API callers without thinking or message caching get `forced`.

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
- A hint is a suggestion, not a decision: in `hint` mode the LLM still spends its own reasoning on
  the choice, so the gain is accuracy on large rosters, not latency or cost.
- Validated end to end on subscriptions (Codex 0.154 on ChatGPT, Claude Code 2.1 on claude.ai) with
  `scripts/mock-jev.mjs` standing in for Jev: `forced`/`none` are accepted by the ChatGPT Codex
  backend, `hint` by Anthropic. Jev's real accuracy on these rosters, and the confidence thresholds,
  still need tuning against a real `TYPESAFE_API_KEY`.

## Layout

```
src/adapters/      wire formats ↔ neutral shapes: chat.ts, responses.ts (Codex), messages.ts (Claude Code)
src/state.ts       conversation → Jev state (truncation, newest-turns budget)
src/questions.ts   tools → Jev questions; detects closed-set parameters
src/decide.ts      the Jev call and the mode decision
src/upstream.ts    streaming reverse proxy
src/app.ts         Hono app: routes, auth, headers, fail-open replay
bin/                jev-codex / jev-claude launchers (shared logic in launcher.mjs)
scripts/mock-jev.mjs  local stand-in for Jev, for end-to-end runs without a TypeSafe key
```

`pnpm test` runs the suite against fake Jev and upstream transports; no keys needed.

# Changelog

## 0.2.0

### Added
- **Monitoring dashboard.** `jev-codex --dashboard` (or `jev-claude --dashboard`) opens a local page
  that shows whether each gateway is routing, passing traffic through, idle, or failing, and why.
  One page covers both gateways and updates live. It shows request metadata only, never prompts,
  tool arguments, or credentials.
- **Token metering.** Every forwarded request records what the provider says it cost: input tokens
  (and how many came from the prompt cache), output tokens (and how many were reasoning), and
  duration. Works for Chat Completions, the Responses API, and Anthropic Messages.
- **Baseline mode.** `--routing off` stops asking Jev but keeps metering, so the dashboard can show
  token use with and without Jev side by side. Also a button on the dashboard and `JEV_ROUTING=off`.
- `HOST` setting for the interface to listen on.

### Changed
- **The gateway now listens on `127.0.0.1` only.** 0.1.0 listened on every interface, which made a
  gateway that forwards your credentials reachable from the local network. Upgrade.
- Launcher flags lost their `jev-` prefix: `--dashboard`, `--routing`, `--status`, `--logs`,
  `--start`, `--stop`. The gateway's own help and config are `--gateway-help` and `--print-config`,
  because `--help` and `--config` belong to Codex and Claude Code. The old `--jev-*` spellings still
  work.
- Requests are logged when their reply ends instead of when it starts, since that is when token
  counts are known.
- Requires Node.js 22.15 or newer.
- README rewritten around getting started.

### Fixed
- `--stop` now stops whichever gateway answers on the port, including one started by an older
  version that recorded its pid elsewhere.

## 0.1.0

First release: tool selection routed to Jev for Chat Completions, the Responses API, and Anthropic
Messages, with the `jev-codex` and `jev-claude` launchers.

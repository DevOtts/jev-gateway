#!/usr/bin/env node
// jev-codex: run Codex through a local jev-gateway — nothing in ~/.codex is modified.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runLauncher } from "./launcher.mjs";

/** Codex talks to a different backend depending on how the user logged in. */
function detectUpstream() {
  if (process.env.JEV_CODEX_UPSTREAM_BASE_URL) return process.env.JEV_CODEX_UPSTREAM_BASE_URL;
  try {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    if (auth.auth_mode === "chatgpt" || (auth.tokens && !auth.OPENAI_API_KEY)) {
      return "https://chatgpt.com/backend-api/codex";
    }
  } catch {
    // No readable login: assume API-key usage.
  }
  return "https://api.openai.com/v1";
}

const provider = (origin) => ({
  name: `"jev-gateway"`,
  base_url: `"${origin}/v1"`,
  wire_api: `"responses"`,
  // Reuse whatever login Codex already has; the router forwards it upstream untouched.
  requires_openai_auth: "true",
});

await runLauncher({
  name: "jev-codex",
  client: "codex",
  portEnv: "JEV_CODEX_PORT",
  defaultPort: 8790,
  upstream: detectUpstream,
  upstreamHelp:
    "JEV_CODEX_UPSTREAM_BASE_URL   where Codex traffic goes; default follows your Codex login:\n" +
    "                                ChatGPT login → https://chatgpt.com/backend-api/codex\n" +
    "                                API key       → https://api.openai.com/v1",
  args: (origin) => [
    "-c",
    `model_provider="jev-gateway"`,
    ...Object.entries(provider(origin)).flatMap(([key, value]) => ["-c", `model_providers.jev-gateway.${key}=${value}`]),
  ],
  configHelp: (origin) =>
    `# Save as ~/.codex/jev.config.toml, keep the router running (jev-codex --start),\n` +
    `# then use: codex --profile jev\n` +
    `model_provider = "jev-gateway"\n\n[model_providers.jev-gateway]\n` +
    Object.entries(provider(origin))
      .map(([key, value]) => `${key} = ${value}`)
      .join("\n"),
});

#!/usr/bin/env node
// jev-codex: run Codex through a local jev-router. Starts the router if it isn't up, then
// launches `codex` with a provider override — nothing in ~/.codex is modified.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(homedir(), ".jev-router");
const LOG_FILE = join(STATE_DIR, "codex.log");
const PID_FILE = join(STATE_DIR, "codex.pid");

// The repo's .env supplies TYPESAFE_API_KEY and tuning knobs; real env vars win over it.
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const PORT = Number(process.env.JEV_CODEX_PORT ?? 8790);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const HELP = `jev-codex — Codex CLI with tool selection routed through Jev

  jev-codex [codex args…]   start the router if needed, then run codex through it
  jev-codex --jev-start     only start the background router
  jev-codex --jev-status    is the router up, and where does it forward to?
  jev-codex --jev-logs      follow the router's decisions (run in a second terminal)
  jev-codex --jev-stop      stop the background router
  jev-codex --jev-config    print a ~/.codex profile, to use plain \`codex --profile jev\` instead

Environment (or ${join(ROOT, ".env")}):
  TYPESAFE_API_KEY              required — Jev makes the tool-selection call
  JEV_CODEX_PORT                router port for Codex (default 8790)
  JEV_CODEX_UPSTREAM_BASE_URL   where Codex traffic goes; default follows your Codex login:
                                ChatGPT login → https://chatgpt.com/backend-api/codex
                                API key       → https://api.openai.com/v1
`;

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

async function health() {
  try {
    const response = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

const tailLog = (lines = 15) =>
  existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").trimEnd().split("\n").slice(-lines).join("\n") : "";

async function ensureRouter() {
  const upstream = detectUpstream();
  const running = await health();
  if (running) {
    if (running.upstream !== upstream.replace(/\/+$/, "")) {
      console.error(`jev-codex: router on :${PORT} forwards to ${running.upstream}, expected ${upstream}.`);
      console.error("           Run `jev-codex --jev-stop` and try again.");
      process.exit(1);
    }
    return;
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error(`jev-codex: TYPESAFE_API_KEY is not set. Export it, or put it in ${join(ROOT, ".env")}`);
    process.exit(1);
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const log = openSync(LOG_FILE, "a");
  // Codex authenticates itself (ChatGPT token or API key); the gateway must not swap that out.
  const { UPSTREAM_API_KEY: _drop, ROUTER_API_KEY: _drop2, ...env } = process.env;
  const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/index.ts")], {
    cwd: ROOT,
    env: { ...env, PORT: String(PORT), UPSTREAM_BASE_URL: upstream },
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));

  let exited = false;
  child.once("exit", () => (exited = true));
  for (let attempt = 0; attempt < 50 && !exited; attempt++) {
    if (await health()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  console.error(`jev-codex: the router did not start. Last log lines (${LOG_FILE}):\n${tailLog()}`);
  process.exit(1);
}

function stopRouter() {
  if (!existsSync(PID_FILE)) return console.log("jev-codex: no background router recorded.");
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  try {
    process.kill(pid);
    console.log(`jev-codex: stopped router (pid ${pid}).`);
  } catch {
    console.log("jev-codex: router was not running.");
  }
  rmSync(PID_FILE, { force: true });
}

const providerOverrides = () => [
  `model_provider="jev-router"`,
  `model_providers.jev-router.name="jev-router"`,
  `model_providers.jev-router.base_url="${ORIGIN}/v1"`,
  `model_providers.jev-router.wire_api="responses"`,
  // Reuse whatever login Codex already has; the router forwards it upstream untouched.
  `model_providers.jev-router.requires_openai_auth=true`,
];

const [flag] = process.argv.slice(2);
if (flag === "--jev-help") {
  console.log(HELP);
} else if (flag === "--jev-stop") {
  stopRouter();
} else if (flag === "--jev-start") {
  await ensureRouter();
  console.log(`jev-codex: router up on ${ORIGIN} → ${detectUpstream()} (logs: ${LOG_FILE})`);
} else if (flag === "--jev-status") {
  const running = await health();
  console.log(running ? `jev-codex: router up on ${ORIGIN} → ${running.upstream}` : `jev-codex: router is not running`);
  console.log(`logs: ${LOG_FILE}`);
} else if (flag === "--jev-logs") {
  mkdirSync(STATE_DIR, { recursive: true });
  closeSync(openSync(LOG_FILE, "a"));
  spawn("tail", ["-n", "30", "-f", LOG_FILE], { stdio: "inherit" });
} else if (flag === "--jev-config") {
  console.log(`# Save as ~/.codex/jev.config.toml, keep the router running (jev-codex --jev-start),`);
  console.log(`# then use: codex --profile jev`);
  console.log(`model_provider = "jev-router"\n\n[model_providers.jev-router]`);
  console.log(`name = "jev-router"\nbase_url = "${ORIGIN}/v1"\nwire_api = "responses"\nrequires_openai_auth = true`);
} else {
  await ensureRouter();
  const args = [...providerOverrides().flatMap((override) => ["-c", override]), ...process.argv.slice(2)];
  const codex = spawn("codex", args, { stdio: "inherit" });
  codex.on("error", (error) => {
    console.error(`jev-codex: could not run codex: ${error.message}`);
    process.exit(127);
  });
  // The router is left running for the next session; `jev-codex --jev-stop` ends it.
  codex.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  // Ctrl-C reaches codex directly (same foreground process group); it decides what that means.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => codex.kill("SIGTERM"));
}

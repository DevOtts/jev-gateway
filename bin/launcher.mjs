// Shared by the jev-<client> launchers: keep one background router per client alive, then run
// the client pointed at it. Nothing in the client's own config directory is ever modified.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(homedir(), ".jev-gateway");
// A git checkout runs the TypeScript sources directly; an installed package only ships dist/.
const FROM_SOURCE = existsSync(join(ROOT, "src/index.ts"));
const ROUTER_ARGS = FROM_SOURCE ? ["--import", "tsx", join(ROOT, "src/index.ts")] : [join(ROOT, "dist/index.js")];
/** Where TYPESAFE_API_KEY and tuning knobs may live; the first file to set a variable wins. */
const ENV_FILES = [...(FROM_SOURCE ? [join(ROOT, ".env")] : []), join(STATE_DIR, ".env")];

/**
 * @param {object} spec
 * @param {string} spec.name         launcher name, e.g. "jev-claude"
 * @param {string} spec.client       binary to run, e.g. "claude"; also names the log/pid files
 * @param {string} spec.portEnv      env var overriding the router port
 * @param {number} spec.defaultPort
 * @param {() => string} spec.upstream        where this client's traffic is forwarded
 * @param {string} spec.upstreamHelp          help text describing the upstream default
 * @param {(origin: string) => string[]} [spec.args]   extra leading arguments for the client
 * @param {(origin: string) => Record<string, string>} [spec.env]  extra environment for the client
 * @param {(origin: string) => string} spec.configHelp  how to wire the client up permanently
 */
export async function runLauncher(spec) {
  // Real environment variables win over both files.
  for (const file of ENV_FILES) if (existsSync(file)) process.loadEnvFile(file);

  const port = Number(process.env[spec.portEnv] ?? spec.defaultPort);
  const origin = `http://127.0.0.1:${port}`;
  const logFile = join(STATE_DIR, `${spec.client}.log`);
  const pidFile = join(STATE_DIR, `${spec.client}.pid`);

  const help = `${spec.name} — ${spec.client} with tool selection routed through Jev

  ${spec.name} [${spec.client} args…]   start the router if needed, then run ${spec.client} through it
  ${spec.name} --jev-start     only start the background router
  ${spec.name} --jev-status    is the router up, and where does it forward to?
  ${spec.name} --jev-logs      follow the router's decisions (run in a second terminal)
  ${spec.name} --jev-stop      stop the background router
  ${spec.name} --jev-config    how to point plain \`${spec.client}\` at the router permanently

Environment (or ${ENV_FILES.at(-1)}):
  TYPESAFE_API_KEY   required — Jev makes the tool-selection call
  ${spec.portEnv}   router port for ${spec.client} (default ${spec.defaultPort})
  ${spec.upstreamHelp}
`;

  const health = async () => {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };

  const tailLog = (lines = 15) =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n") : "";

  const ensureRouter = async () => {
    const upstream = spec.upstream().replace(/\/+$/, "");
    const running = await health();
    if (running) {
      if (running.upstream === upstream) return;
      console.error(`${spec.name}: router on :${port} forwards to ${running.upstream}, expected ${upstream}.`);
      console.error(`${" ".repeat(spec.name.length)}  Run \`${spec.name} --jev-stop\` and try again.`);
      process.exit(1);
    }
    if (!process.env.TYPESAFE_API_KEY) {
      console.error(`${spec.name}: TYPESAFE_API_KEY is not set. Export it, or put it in ${ENV_FILES.at(-1)}`);
      process.exit(1);
    }

    mkdirSync(STATE_DIR, { recursive: true });
    const log = openSync(logFile, "a");
    // The client authenticates itself (subscription login or its own key); the gateway must not swap that out.
    const { UPSTREAM_API_KEY: _key, ROUTER_API_KEY: _routerKey, ...env } = process.env;
    const child = spawn(process.execPath, ROUTER_ARGS, {
      cwd: ROOT,
      env: { ...env, PORT: String(port), UPSTREAM_BASE_URL: upstream },
      detached: true,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    child.unref();
    writeFileSync(pidFile, String(child.pid));

    let exited = false;
    child.once("exit", () => (exited = true));
    for (let attempt = 0; attempt < 50 && !exited; attempt++) {
      if (await health()) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    console.error(`${spec.name}: the router did not start. Last log lines (${logFile}):\n${tailLog()}`);
    process.exit(1);
  };

  const stopRouter = () => {
    if (!existsSync(pidFile)) return console.log(`${spec.name}: no background router recorded.`);
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      process.kill(pid);
      console.log(`${spec.name}: stopped router (pid ${pid}).`);
    } catch {
      console.log(`${spec.name}: router was not running.`);
    }
    rmSync(pidFile, { force: true });
  };

  const [flag] = process.argv.slice(2);
  if (flag === "--jev-help") return console.log(help);
  if (flag === "--jev-stop") return stopRouter();
  if (flag === "--jev-config") return console.log(spec.configHelp(origin));
  if (flag === "--jev-start") {
    await ensureRouter();
    return console.log(`${spec.name}: router up on ${origin} → ${spec.upstream()} (logs: ${logFile})`);
  }
  if (flag === "--jev-status") {
    const running = await health();
    console.log(running ? `${spec.name}: router up on ${origin} → ${running.upstream}` : `${spec.name}: router is not running`);
    return console.log(`logs: ${logFile}`);
  }
  if (flag === "--jev-logs") {
    mkdirSync(STATE_DIR, { recursive: true });
    closeSync(openSync(logFile, "a"));
    return spawn("tail", ["-n", "30", "-f", logFile], { stdio: "inherit" });
  }

  await ensureRouter();
  const child = spawn(spec.client, [...(spec.args?.(origin) ?? []), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ...spec.env?.(origin) },
  });
  child.on("error", (error) => {
    console.error(`${spec.name}: could not run ${spec.client}: ${error.message}`);
    process.exit(127);
  });
  // The router is left running for the next session; `--jev-stop` ends it.
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  // Ctrl-C reaches the client directly (same foreground process group); it decides what that means.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

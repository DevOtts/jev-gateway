#!/usr/bin/env node
// Proves the chess tasks measure what they claim, without any agent: the reference must pass every
// check, every starting workspace must fail some, and each injected bug must be caught on its own.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUGS, engineWithoutSan, inject, solution, tasks } from "./tasks/chess/tasks.mjs";

function score(task, source) {
  const workspace = mkdtempSync(join(tmpdir(), "jev-bench-selftest-"));
  try {
    task.setup(workspace);
    if (source !== undefined) writeFileSync(join(workspace, "src/chess.js"), source);
    const [script, ...args] = task.verify(workspace);
    const lines = execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }).trim().split("\n").map((line) => JSON.parse(line));
    const checks = lines.filter((line) => line.name);
    return { passed: checks.filter((line) => line.ok).length, total: lines[0].total, failed: checks.filter((line) => !line.ok).map((line) => line.name) };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

let failures = 0;
const expect = (what, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

for (const task of tasks) {
  const start = score(task);
  expect(`${task.id}: the starting workspace does not already pass`, start.passed < start.total, `${start.passed}/${start.total}`);
  const done = score(task, solution());
  expect(`${task.id}: the reference solution passes every check`, done.passed === done.total, `${done.passed}/${done.total} ${done.failed.join("; ")}`);
}
const bugfix = tasks.find((task) => task.id === "chess-bugfix");
for (const bug of BUGS) {
  const result = score(bugfix, inject(engineWithoutSan(), [bug]));
  expect(`chess-bugfix: "${bug[0]}" is caught on its own`, result.passed < result.total, result.failed.slice(0, 2).join("; "));
}
process.exit(failures ? 1 : 0);

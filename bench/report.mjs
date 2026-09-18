#!/usr/bin/env node
// Turns runs.jsonl into a comparison: node bench/report.mjs <results dir> [--prices in,cached,out]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const int = (value) => (value === undefined ? "n/a" : Math.round(value).toLocaleString("en-US"));
const percent = (value) => (value === undefined ? "n/a" : Math.round(100 * value) + "%");
const change = (withJev, without) =>
  withJev === undefined || !without ? "" : ` (${withJev >= without ? "+" : ""}${Math.round((100 * (withJev - without)) / without)}%)`;

/** What the provider would bill for a run; cached input is part of `input`, at its own price. */
const cost = (run, prices) =>
  ((run.input - run.cached) * prices.input + run.cached * prices.cached + run.output * prices.output) / 1e6 + (run.jevInput * 0.042) / 1e6;

export function summarize(runs, prices) {
  const lines = ["# Benchmark summary", ""];
  const tasks = [...new Set(runs.map((run) => run.task))];
  const metrics = [
    ["Runs", (group) => group.length, int],
    ["Solved (every check passed)", (group) => group.filter((run) => run.solved).length / group.length, percent],
    ["Checks passed, median", (group) => median(group.map((run) => run.score)), percent],
    ["LLM requests, median", (group) => median(group.map((run) => run.requests)), int],
    ["Input tokens, median", (group) => median(group.map((run) => run.input)), int],
    ["…of which cached", (group) => median(group.map((run) => (run.input ? run.cached / run.input : undefined))), percent],
    ["Output tokens, median", (group) => median(group.map((run) => run.output)), int],
    ["…of which reasoning", (group) => median(group.map((run) => run.reasoning)), int],
    ["Wall-clock seconds, median", (group) => median(group.map((run) => run.seconds)), (value) => (value === undefined ? "n/a" : value.toFixed(1))],
    ["Jev calls, median", (group) => median(group.map((run) => run.jevCalls)), int],
    ["Requests Jev steered", (group) => median(group.map((run) => (run.requests ? 1 - (run.modes.passthrough ?? 0) / run.requests : undefined))), percent],
    ["Failed LLM requests, total", (group) => group.reduce((total, run) => total + run.failedRequests, 0), int],
    ["Agent timeouts", (group) => group.filter((run) => run.timedOut).length, int],
  ];
  if (prices) {
    metrics.push(["Cost per run, median (USD)", (group) => median(group.map((run) => cost(run, prices))), (value) => (value === undefined ? "n/a" : value.toFixed(4))]);
    // The number that matters: what a finished task costs, failures included in the bill.
    metrics.push([
      "Cost per solved task (USD)",
      (group) => (group.some((run) => run.solved) ? group.reduce((total, run) => total + cost(run, prices), 0) / group.filter((run) => run.solved).length : undefined),
      (value) => (value === undefined ? "n/a" : value.toFixed(4)),
    ]);
  }

  for (const task of tasks) {
    const withJev = runs.filter((run) => run.task === task && run.mode === "on");
    const without = runs.filter((run) => run.task === task && run.mode === "off");
    lines.push(`## ${task}`, "", "| | Routing on | Routing off (baseline) |", "| --- | ---: | ---: |");
    for (const [label, measure, format] of metrics) {
      const [a, b] = [withJev, without].map((group) => (group.length ? measure(group) : undefined));
      const comparable = label.includes("median") || label.startsWith("Cost");
      lines.push(`| ${label} | ${format(a)}${comparable ? change(a, b) : ""} | ${format(b)} |`);
    }
    lines.push("");
  }
  const smallest = Math.min(...tasks.flatMap((task) => ["on", "off"].map((mode) => runs.filter((run) => run.task === task && run.mode === mode).length)));
  lines.push(
    smallest < 5
      ? `Only ${smallest} run${smallest === 1 ? "" : "s"} per cell: agents vary a lot from one run to the next, so treat differences here as anecdotes, not measurements. Five or more repetitions per mode start to mean something.`
      : "Percentages in brackets compare the routing-on median with the baseline median.",
  );
  return lines.join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: node bench/report.mjs <results dir> [--prices in,cached,out]");
  const runs = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const flag = process.argv.indexOf("--prices");
  const prices = flag > 0 ? process.argv[flag + 1].split(",").map(Number) : undefined;
  console.log(summarize(runs, prices && { input: prices[0], cached: prices[1], output: prices[2] }));
}

#!/usr/bin/env node
// A stand-in agent for testing the benchmark itself: node fake-agent.mjs <gateway> <workspace> <task>
// It talks to the gateway the way Codex does (a few Responses API turns with a tool roster), then
// writes the reference solution, so a full run can be checked end to end without an LLM or quota.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineWithoutSan, solution } from "../tasks/chess/tasks.mjs";

const [origin, workspace, task] = process.argv.slice(2);
const tools = [
  { type: "function", name: "exec_command", description: "Run a shell command.", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
  { type: "custom", name: "apply_patch", description: "Edit files by applying a patch." },
];
const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fix the failing tests." }] }];

for (let turn = 0; turn < 4; turn++) {
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model", stream: true, input, tools, tool_choice: "auto" }),
  });
  await response.text();
  input.push(
    { type: "function_call", name: "exec_command", arguments: '{"cmd":"npm test"}', call_id: `call_${turn}` },
    { type: "function_call_output", call_id: `call_${turn}`, output: turn < 3 ? "1 failing" : "all passing" },
  );
}
writeFileSync(join(workspace, "src/chess.js"), task === "chess-san" ? solution() : engineWithoutSan());

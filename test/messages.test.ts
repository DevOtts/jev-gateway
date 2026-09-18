import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

/** Shaped like what Claude Code sends: block-based system and messages, client + Anthropic-run tools. */
const claudeRequest = (extra: Record<string, unknown> = {}) => ({
  model: "claude-test",
  max_tokens: 1024,
  stream: true,
  system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "what does main.py do?" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "…", signature: "sig" },
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "main.py" }] }] },
  ],
  tools: [
    {
      name: "Bash",
      description: "Run a shell command.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    { name: "ExitPlanMode", description: "Leave plan mode.", input_schema: { type: "object", properties: {} } },
    { type: "web_search_20250305", name: "web_search" },
  ],
  ...extra,
});

function setup(canned: Parameters<typeof fakeJev>[0]) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  const post = (body: unknown) =>
    app.request("/v1/messages?beta=true", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "oauth-2025-04-20", authorization: "Bearer oauth" },
      body: JSON.stringify(body),
    });
  return { post, jev, upstream };
}

const bash = { tool: { choice: "Bash" }, needs_tool: { noul: 0.9 } };

describe("POST /v1/messages", () => {
  it("splits block messages into turns Jev can read, skipping thinking", async () => {
    const { post, jev } = setup(bash);
    await post(claudeRequest());

    const { state, questions } = jev.requests[0]!;
    expect(state).toEqual({
      assistant_instructions: "You are Claude Code.",
      conversation: [
        { role: "user", text: "what does main.py do?" },
        { role: "assistant", text: "Let me look." },
        { role: "assistant", tool_calls: [{ tool: "Bash", arguments: '{"command":"ls"}' }] },
        { role: "tool_result", tool: "Bash", content: "main.py" },
      ],
    });
    const tool = questions.tool!;
    expect(tool.type === "choice" && Object.keys(tool.criteria)).toEqual(["Bash", "ExitPlanMode", "web_search", NO_TOOL]);
  });

  it("forces Jev's tool and forwards the subscription headers and query untouched", async () => {
    const { post, upstream } = setup(bash);
    const res = await post(claudeRequest({ tool_choice: { type: "auto", disable_parallel_tool_use: true } }));

    expect(res.headers.get("x-jev-router-mode")).toBe("forced");
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://llm.test/v1/messages?beta=true");
    expect(call.body.tool_choice).toEqual({ type: "tool", name: "Bash", disable_parallel_tool_use: true });
    expect(call.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(call.headers.get("authorization")).toBe("Bearer oauth");
  });

  it("never forces a tool while extended thinking is on, since the API would reject it", async () => {
    const { post, upstream } = setup(bash);
    const body = claudeRequest({ thinking: { type: "enabled", budget_tokens: 2000 } });
    const res = await post(body);
    expect(res.headers.get("x-jev-router-reason")).toBe("forcing_unsupported");
    expect(upstream.calls[0]!.body).toEqual(body);
  });

  it("still turns tools off under thinking when Jev is sure none is needed", async () => {
    const { post, upstream } = setup({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } });
    await post(claudeRequest({ thinking: { type: "adaptive" } }));
    expect(upstream.calls[0]!.body.tool_choice).toEqual({ type: "none" });
  });

  it("streams a complete tool_use itself when the tool takes no open-ended input", async () => {
    const { post, upstream } = setup({ tool: { choice: "ExitPlanMode" }, needs_tool: { noul: 0.9 } });
    const res = await post(claudeRequest());
    expect(upstream.calls).toHaveLength(0);

    const events = (await res.text())
      .trim()
      .split("\n\n")
      .map((block) => JSON.parse(block.split("\n")[1]!.replace(/^data: /, "")));
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1].content_block).toMatchObject({ type: "tool_use", name: "ExitPlanMode" });
    expect(events[4].delta.stop_reason).toBe("tool_use");
  });

  it("maps tool_choice any to a required tool and leaves named choices alone", async () => {
    const required = setup(bash);
    await required.post(claudeRequest({ tool_choice: { type: "any" } }));
    const question = required.jev.requests[0]!.questions.tool!;
    expect(question.type === "choice" && NO_TOOL in question.criteria).toBe(false);

    const named = setup(bash);
    await named.post(claudeRequest({ tool_choice: { type: "tool", name: "Bash" } }));
    expect(named.jev.requests).toHaveLength(0);
  });
});

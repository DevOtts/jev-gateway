import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const geminiRequest = (extra: Record<string, unknown> = {}) => ({
  contents: [
    {
      role: "user",
      parts: [{ text: "what does main.py do?" }],
    },
    {
      role: "model",
      parts: [
        {
          functionCall: {
            name: "shell",
            args: { command: "ls" },
          },
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "shell",
            response: { output: "main.py\nREADME.md" },
          },
        },
      ],
    },
  ],
  systemInstruction: {
    parts: [{ text: "You are a helpful coding assistant." }],
  },
  tools: [
    {
      functionDeclarations: [
        {
          name: "shell",
          description: "Runs a shell command.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    },
  ],
  ...extra,
});

function setup(canned: Parameters<typeof fakeJev>[0]) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  const post = (body: unknown, path = "/v1beta/models/gemini-2.0-flash:generateContent") =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, jev, upstream, app };
}

const shellDecision = { tool: { choice: "shell" }, needs_tool: { noul: 0.95 } };

describe("POST /v1beta/models/...:generateContent", () => {
  it("translates Gemini contents and systemInstruction into Jev turns and tool declarations", async () => {
    const { post, jev } = setup(shellDecision);
    await post(geminiRequest());

    const { state } = jev.requests[0]!;
    expect(state).toEqual({
      assistant_instructions: "You are a helpful coding assistant.",
      conversation: [
        { role: "user", text: "what does main.py do?" },
        { role: "assistant", tool_calls: [{ tool: "shell", arguments: '{"command":"ls"}' }] },
        { role: "tool_result", tool: "shell", content: '{"output":"main.py\\nREADME.md"}' },
      ],
    });
  });

  it("forces tool selection by updating toolConfig.functionCallingConfig", async () => {
    const { post, upstream } = setup(shellDecision);
    await post(geminiRequest());

    expect(upstream.calls).toHaveLength(1);
    const sent = upstream.calls[0]!.body as {
      toolConfig?: { functionCallingConfig?: { mode: string; allowedFunctionNames?: string[] } };
    };
    expect(sent.toolConfig?.functionCallingConfig).toEqual({
      mode: "ANY",
      allowedFunctionNames: ["shell"],
    });
  });

  it("answers directly without an upstream call when all arguments are resolved", async () => {
    const { post, upstream } = setup({
      tool: { choice: "set_lights" },
      needs_tool: { noul: 0.95 },
      "arg:0:room": { choice: "bedroom" },
      "arg:0:on": { noul: 0.99 },
    });
    const response = await post(
      geminiRequest({
        tools: [
          {
            functionDeclarations: [
              {
                name: "set_lights",
                description: "Turn lights on or off",
                parameters: {
                  type: "object",
                  properties: {
                    room: { type: "string", enum: ["kitchen", "bedroom"] },
                    on: { type: "boolean" },
                  },
                  required: ["room", "on"],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(upstream.calls).toHaveLength(0);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ functionCall?: { name: string; args: unknown } }> } }>;
    };
    expect(body.candidates[0]!.content.parts[0]!.functionCall).toEqual({
      name: "set_lights",
      args: { room: "bedroom", on: true },
    });
  });

  it("disables tools when Jev is confident no tool is needed", async () => {
    const { post, upstream } = setup({
      tool: { choice: NO_TOOL },
      needs_tool: { noul: 0.05 },
    });
    await post(geminiRequest());

    expect(upstream.calls).toHaveLength(1);
    const sent = upstream.calls[0]!.body as {
      toolConfig?: { functionCallingConfig?: { mode: string } };
    };
    expect(sent.toolConfig?.functionCallingConfig).toEqual({
      mode: "NONE",
    });
  });

  it("auto-detects Gemini wire format in /router/decide", async () => {
    const { app } = setup(shellDecision);
    const res = await app.request("/router/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(geminiRequest()),
    });

    expect(res.status).toBe(200);
    const decision = (await res.json()) as { mode: string; tool?: string };
    expect(decision.mode).toBe("forced");
    expect(decision.tool).toBe("shell");
  });
});

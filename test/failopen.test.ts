import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeJev, fakeUpstream, settled, testConfig, tools } from "./helpers.js";

const weather = { tool: { choice: "get_weather" }, needs_tool: { noul: 0.97 } };

function setup(canned: Parameters<typeof fakeJev>[0] = weather, config = testConfig()) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const app = createApp({ config, askJev: jev.askJev, fetch: upstream.fetchImpl });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, post, jev, upstream };
}

/** The options Jev was given for the tool question. */
const offered = (jev: ReturnType<typeof fakeJev>) => Object.keys(jev.requests[0]?.questions.tool?.criteria ?? {});

const anthropicTool = (name: string) => ({
  name,
  description: "Read a file from disk.",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
});

describe("bodies that are JSON but not the documented shape", () => {
  // Each of these made an adapter throw, and the client got a 500 for a request upstream would
  // have answered itself.
  const malformed: [string, string, unknown][] = [
    ["a null message", "/v1/chat/completions", { model: "m", messages: [null], tools }],
    ["a message that is a string", "/v1/chat/completions", { model: "m", messages: ["hi"], tools }],
    ["a null tool", "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }], tools: [null] }],
    ["tool_calls that is not a list", "/v1/chat/completions", { model: "m", messages: [{ role: "assistant", tool_calls: 7 }], tools }],
    ["a tool call without a function", "/v1/chat/completions", { model: "m", messages: [{ role: "assistant", tool_calls: [{ id: "c" }] }], tools }],
    ["numeric content", "/v1/messages", { model: "m", messages: [{ role: "user", content: 123 }], tools: [anthropicTool("read")] }],
    ["a null content block", "/v1/messages", { model: "m", messages: [{ role: "user", content: [null] }], tools: [anthropicTool("read")] }],
    ["a null message", "/v1/messages", { model: "m", messages: [null], tools: [anthropicTool("read")] }],
    ["a null tool", "/v1/messages", { model: "m", messages: [{ role: "user", content: "hi" }], tools: [null] }],
    ["a null input item", "/v1/responses", { model: "m", input: [null], tools: [{ type: "function", name: "read" }] }],
    ["a null tool", "/v1/responses", { model: "m", input: "hi", tools: [null] }],
    ["a message whose content holds null", "/v1/responses", { model: "m", input: [{ role: "user", content: [null] }], tools: [{ type: "function", name: "read" }] }],
    ["null contents", "/v1beta/models/gemini-test:generateContent", { contents: [null], tools: [{ functionDeclarations: [{ name: "read" }] }] }],
    ["a null part", "/v1beta/models/gemini-test:generateContent", { contents: [{ role: "user", parts: [null] }], tools: [{ functionDeclarations: [{ name: "read" }] }] }],
    ["a null tool group", "/v1beta/models/gemini-test:generateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [null] }],
    ["a null declaration", "/v1beta/models/gemini-test:generateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: [null] }] }],
  ];

  it.each(malformed)("passes %s through on %s instead of failing", async (_what, path, body) => {
    const { post, upstream } = setup();
    const response = await post(path, body);
    await settled();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toEqual(body);
  });

  it("says why, so the dashboard can", async () => {
    const { post } = setup();
    const response = await post("/v1/chat/completions", { model: "m", messages: [null], tools });
    expect(response.headers.get("x-jev-gateway-reason")).toBe("unreadable_request");
  });
});

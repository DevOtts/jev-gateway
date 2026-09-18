import { randomBytes } from "node:crypto";
import type { Decision } from "../decide.js";
import { textOf, truncate } from "../state.js";
import type { DirectCall, JsonSchema, RouterInput, RouterTool, Turn } from "../types.js";
import { sse, type Adapter } from "./adapter.js";

/** OpenAI Responses API (`POST /v1/responses`) — the only wire format Codex speaks. */

interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: JsonSchema;
}

interface InputItem {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  call_id?: string;
  arguments?: string;
  input?: string;
  output?: unknown;
  action?: { command?: string[] };
}

export interface ResponsesRequest {
  model?: string;
  instructions?: string | null;
  input?: string | InputItem[];
  tools?: ResponsesTool[];
  tool_choice?: unknown;
  previous_response_id?: string | null;
  stream?: boolean;
  [key: string]: unknown;
}

const HOSTED_DESCRIPTIONS: Record<string, string> = {
  web_search: "Search the web for up-to-date information the assistant does not already have.",
  web_search_preview: "Search the web for up-to-date information the assistant does not already have.",
  local_shell: "Run a shell command on the user's machine.",
  image_generation: "Generate an image.",
  code_interpreter: "Run Python code in a sandbox.",
  file_search: "Search the user's uploaded files.",
};

function toTools(raw: ResponsesTool[]): RouterTool[] {
  const tools = new Map<string, RouterTool>();
  for (const tool of raw) {
    if ((tool.type === "function" || tool.type === "custom") && tool.name) {
      tools.set(tool.name, {
        kind: tool.type,
        name: tool.name,
        description: tool.description,
        parameters: tool.type === "function" ? tool.parameters : undefined,
      });
    } else if (tool.type && !tools.has(tool.type)) {
      tools.set(tool.type, {
        kind: "hosted",
        name: tool.type,
        description: HOSTED_DESCRIPTIONS[tool.type] ?? tool.description ?? `The built-in ${tool.type} tool.`,
      });
    }
  }
  return [...tools.values()];
}

function toInput(req: ResponsesRequest, maxMessageChars: number): RouterInput | { skip: string } {
  // With server-side history the router would be judging a conversation it cannot see.
  if (req.previous_response_id) return { skip: "previous_response_id" };
  const items: InputItem[] =
    typeof req.input === "string" ? [{ role: "user", content: req.input }] : Array.isArray(req.input) ? req.input : [];
  const clip = (value: unknown) => truncate(typeof value === "string" ? value : textOf(value), maxMessageChars);

  const toolNameByCallId = new Map<string, string>();
  const system = typeof req.instructions === "string" && req.instructions ? [req.instructions] : [];
  const turns: Turn[] = [];
  for (const item of items) {
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "message") {
      const text = clip(item.content);
      if (item.role === "system" || item.role === "developer") {
        if (text) system.push(text);
      } else {
        turns.push({ role: item.role ?? "user", text });
      }
    } else if (type === "function_call" || type === "custom_tool_call") {
      if (item.call_id && item.name) toolNameByCallId.set(item.call_id, item.name);
      turns.push({
        role: "assistant",
        tool_calls: [{ tool: item.name ?? "unknown", arguments: clip(item.arguments ?? item.input ?? "") }],
      });
    } else if (type === "local_shell_call") {
      if (item.call_id) toolNameByCallId.set(item.call_id, "local_shell");
      turns.push({
        role: "assistant",
        tool_calls: [{ tool: "local_shell", arguments: clip((item.action?.command ?? []).join(" ")) }],
      });
    } else if (type?.endsWith("_call_output")) {
      turns.push({
        role: "tool_result",
        tool: toolNameByCallId.get(item.call_id ?? "") ?? "unknown",
        content: clip(item.output),
      });
    }
    // Reasoning items (encrypted), item references and hosted-tool traces carry nothing Jev can read.
  }

  const choice = req.tool_choice ?? "auto";
  return {
    system: system.join("\n\n"),
    turns,
    tools: toTools(Array.isArray(req.tools) ? req.tools : []),
    toolChoice: choice === "auto" || choice === "required" ? choice : "decided",
  };
}

function apply(req: ResponsesRequest, decision: Decision, argsModel?: string): ResponsesRequest {
  if (decision.mode === "forced") {
    return {
      ...req,
      model: argsModel ?? req.model,
      tool_choice: { type: decision.kind === "custom" ? "custom" : "function", name: decision.tool },
    };
  }
  if (decision.mode === "none") return { ...req, tool_choice: "none" };
  return req;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function build(req: ResponsesRequest, call: DirectCall) {
  const item = {
    type: "function_call",
    id: `fc_${hex(16)}`,
    call_id: `call_${hex(12)}`,
    name: call.tool,
    arguments: JSON.stringify(call.args),
    status: "completed",
  };
  const response = {
    id: `resp_jev_${hex(16)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    model: req.model ?? "jev-router",
    output: [item],
    parallel_tool_calls: req.parallel_tool_calls ?? true,
    previous_response_id: null,
    store: false,
    tool_choice: req.tool_choice ?? "auto",
    tools: req.tools ?? [],
    metadata: {},
    usage: {
      input_tokens: call.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: call.inputTokens,
    },
  };
  return { item, response };
}

function directJson(req: ResponsesRequest, call: DirectCall) {
  return build(req, call).response;
}

/** The event sequence an LLM-produced function call would stream. */
function directStream(req: ResponsesRequest, call: DirectCall): string {
  const { item, response } = build(req, call);
  const pending = { ...response, status: "in_progress", output: [], usage: null };
  const at = { item_id: item.id, output_index: 0 };
  const events: Record<string, unknown>[] = [
    { type: "response.created", response: pending },
    { type: "response.in_progress", response: pending },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", ...at, delta: item.arguments },
    { type: "response.function_call_arguments.done", ...at, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return sse(
    events.map((event, sequence_number) => ({
      event: event.type as string,
      data: JSON.stringify({ ...event, sequence_number }),
    })),
  );
}

export const responsesAdapter: Adapter<ResponsesRequest> = { toInput, apply, directJson, directStream };

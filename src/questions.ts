import type { Questions } from "@typesafe-ai/sdk";
import { truncate } from "./state.js";
import type { Json, JsonSchema, RouterTool } from "./types.js";

/** Choice label meaning "reply in text, call nothing". */
export const NO_TOOL = "no_tool_needed";
/** A Choice accepts up to 255 options; one is reserved for NO_TOOL. */
export const MAX_TOOLS = 254;
/** Cap on speculative argument questions fanned out in the same Jev call. */
const MAX_ARG_QUESTIONS = 96;
const MAX_DESCRIPTION_CHARS = 1024;

export const TOOL_KEY = "tool";
export const NEEDS_TOOL_KEY = "needs_tool";

/** A parameter whose value comes from a fixed set, so Jev can fill it. */
export type ClosedParam =
  | { name: string; required: boolean; kind: "const"; value: Json }
  | { name: string; required: boolean; kind: "boolean"; description?: string }
  | { name: string; required: boolean; kind: "enum"; description?: string; values: Map<string, Json> };

export interface ToolPlan {
  name: string;
  /** Present only when every parameter is closed-set: Jev can then produce the whole call. */
  closedParams?: ClosedParam[];
}

function closedParam(name: string, schema: JsonSchema, required: boolean): ClosedParam | undefined {
  if ("const" in schema) return { name, required, kind: "const", value: schema.const as Json };
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.length === 1) return { name, required, kind: "const", value: schema.enum[0]! };
    const values = new Map<string, Json>();
    for (const value of schema.enum) {
      if (value !== null && typeof value === "object") return undefined;
      values.set(String(value), value);
    }
    // Labels are what Jev sees; colliding labels ("1" vs 1) can't be mapped back.
    if (values.size !== schema.enum.length || values.size > 255) return undefined;
    return { name, required, kind: "enum", description: schema.description, values };
  }
  if (schema.type === "boolean") return { name, required, kind: "boolean", description: schema.description };
  return undefined;
}

export function planTool(tool: RouterTool): ToolPlan {
  const schema = tool.parameters;
  // Only function tools take JSON arguments, and without a recognizable object schema
  // there is nothing safe to infer about them.
  if (tool.kind !== "function") return { name: tool.name };
  if (schema && schema.type !== undefined && schema.type !== "object") return { name: tool.name };
  const required = new Set(schema?.required ?? []);
  const closedParams: ClosedParam[] = [];
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    const param = closedParam(name, property, required.has(name));
    if (!param) return { name: tool.name };
    closedParams.push(param);
  }
  return { name: tool.name, closedParams };
}

export const argKey = (toolIndex: number, param: string) => `arg:${toolIndex}:${param}`;
export const statedKey = (toolIndex: number, param: string) => `stated:${toolIndex}:${param}`;

function toolDescription(tool: RouterTool): string | null {
  const params = Object.keys(tool.parameters?.properties ?? {});
  const description = tool.description?.trim();
  if (description) return truncate(description, MAX_DESCRIPTION_CHARS);
  return params.length ? `Parameters: ${params.join(", ")}` : null;
}

/**
 * One Jev request decides everything: which tool (if any), whether a tool is needed at all,
 * and — speculatively, for every tool Jev could fully answer — each closed-set argument.
 * Extra questions barely change latency, so code picks the relevant answers afterwards.
 */
export function buildQuestions(
  tools: RouterTool[],
  options: { allowNone: boolean; withArgs: boolean },
): { questions: Questions; plans: ToolPlan[] } {
  const plans = tools.map(planTool);
  const criteria: Record<string, string | null> = {};
  for (const tool of tools) criteria[tool.name] = toolDescription(tool);
  if (options.allowNone) {
    criteria[NO_TOOL] =
      "No tool call is needed right now: the assistant should reply to the user in plain text " +
      "(answer directly, ask a clarifying question, or report results that tools already returned).";
  }

  const questions: Questions = {
    [TOOL_KEY]: {
      type: "choice",
      instructions:
        "Given the conversation, what should the assistant do next? " +
        "Pick the single tool whose call best advances the user's latest request.",
      criteria,
    },
    [NEEDS_TOOL_KEY]: {
      type: "noul",
      instructions:
        "Does the assistant need to call one of its tools now, rather than reply to the user in plain text?",
    },
  };
  if (!options.withArgs) return { questions, plans };

  let argQuestions = 0;
  plans.forEach((plan, toolIndex) => {
    const asked = plan.closedParams?.filter((param) => param.kind !== "const") ?? [];
    const cost = asked.reduce((sum, param) => sum + (param.required ? 1 : 2), 0);
    if (!plan.closedParams || argQuestions + cost > MAX_ARG_QUESTIONS) {
      delete plan.closedParams;
      return;
    }
    argQuestions += cost;
    for (const param of asked) {
      const about = `the "${param.name}" argument of the tool "${plan.name}"${
        param.description ? ` (${truncate(param.description, MAX_DESCRIPTION_CHARS)})` : ""
      }`;
      questions[argKey(toolIndex, param.name)] =
        param.kind === "boolean"
          ? { type: "noul", instructions: `If the assistant calls "${plan.name}" now, should ${about} be true?` }
          : {
              type: "choice",
              instructions: `If the assistant calls "${plan.name}" now, what value should ${about} have?`,
              criteria: Object.fromEntries([...param.values.keys()].map((label) => [label, null])),
            };
      if (!param.required) {
        questions[statedKey(toolIndex, param.name)] = {
          type: "noul",
          instructions: `Does the conversation state or clearly imply a value for ${about}?`,
        };
      }
    }
  });
  return { questions, plans };
}

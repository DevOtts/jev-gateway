import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import type { Config } from "./config.js";
import {
  argKey,
  buildQuestions,
  MAX_TOOLS,
  NEEDS_TOOL_KEY,
  NO_TOOL,
  statedKey,
  TOOL_KEY,
  type ToolPlan,
} from "./questions.js";
import { buildState } from "./state.js";
import type { Json, RouterInput, RouterTool } from "./types.js";

/** The one Jev call the router makes; injectable so tests need no network. */
export type AskJev = (request: SystemOneRequest<Questions>) => Promise<SystemOneResult<Questions>>;

export interface JevTrace {
  choice: string;
  confidence: number;
  needsTool: number;
  topProbabilities: Record<string, number>;
  inputTokens: number;
  latencyMs: number;
}

export type Decision = { jev?: JevTrace } & (
  | { mode: "passthrough"; reason: string }
  /** Jev is confident no tool is needed: the LLM replies in text. */
  | { mode: "none"; confidence: number }
  /** Jev picked the tool: the LLM only fills in its arguments. */
  | { mode: "forced"; tool: string; kind: RouterTool["kind"]; confidence: number }
  /** Jev picked the tool and every argument: no LLM call at all. */
  | { mode: "direct"; tool: string; args: Record<string, Json>; confidence: number }
);

type Answers = SystemOneResult<Questions>["answers"];

/** Why a request is not Jev's to decide, or undefined when it is. */
function skipReason(input: RouterInput): string | undefined {
  if (input.turns.length === 0) return "no_messages";
  if (input.tools.length === 0) return "no_tools";
  if (input.tools.length > MAX_TOOLS) return "too_many_tools";
  if (new Set(input.tools.map((tool) => tool.name)).size !== input.tools.length) return "duplicate_tool_names";
  if (input.tools.some((tool) => tool.name === NO_TOOL)) return "reserved_tool_name";
  if (input.toolChoice === "decided") return "tool_choice_already_decided";
  return undefined;
}

/** Fill every argument from Jev's answers; the weakest judgement bounds the whole call. */
function resolveArgs(
  plan: ToolPlan,
  toolIndex: number,
  answers: Answers,
  minCertainty: number,
): { args: Record<string, Json>; certainty: number } | undefined {
  const args: Record<string, Json> = {};
  let certainty = 1;
  for (const param of plan.closedParams ?? []) {
    if (param.kind === "const") {
      if (param.required) args[param.name] = param.value;
      continue;
    }
    if (!param.required) {
      const stated = answers[statedKey(toolIndex, param.name)];
      if (stated?.type !== "noul") return undefined;
      certainty = Math.min(certainty, Math.max(stated.noul, 1 - stated.noul));
      if (stated.noul < 0.5) continue;
    }
    const answer = answers[argKey(toolIndex, param.name)];
    if (param.kind === "boolean" && answer?.type === "noul") {
      args[param.name] = answer.noul >= 0.5;
      certainty = Math.min(certainty, Math.max(answer.noul, 1 - answer.noul));
    } else if (param.kind === "enum" && answer?.type === "choice" && param.values.has(answer.choice)) {
      args[param.name] = param.values.get(answer.choice)!;
      certainty = Math.min(certainty, answer.confidence);
    } else {
      return undefined;
    }
  }
  return certainty >= minCertainty ? { args, certainty } : undefined;
}

export async function decide(input: RouterInput, config: Config, askJev: AskJev): Promise<Decision> {
  const skip = skipReason(input);
  if (skip) return { mode: "passthrough", reason: skip };

  const { questions, plans } = buildQuestions(input.tools, {
    allowNone: input.toolChoice !== "required",
    withArgs: config.directCalls,
  });

  const startedAt = performance.now();
  let result: SystemOneResult<Questions>;
  try {
    result = await askJev({ state: buildState(input, config), questions, model: config.jevModel });
  } catch (error) {
    // Fail open: a Jev outage must never take the gateway down with it.
    return { mode: "passthrough", reason: `jev_error: ${error instanceof Error ? error.message : String(error)}` };
  }

  const picked = result.answers[TOOL_KEY];
  const needs = result.answers[NEEDS_TOOL_KEY];
  if (picked?.type !== "choice" || needs?.type !== "noul") {
    return { mode: "passthrough", reason: "jev_unexpected_answer" };
  }
  const jev: JevTrace = {
    choice: picked.choice,
    confidence: picked.confidence,
    needsTool: needs.noul,
    topProbabilities: Object.fromEntries(
      Object.entries(picked.probabilities)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3),
    ),
    inputTokens: result.usage.input_tokens,
    latencyMs: Math.round(performance.now() - startedAt),
  };

  if (picked.confidence < config.minConfidence) return { mode: "passthrough", reason: "low_confidence", jev };
  // Two independent questions must agree before the router overrides the LLM.
  const wantsTool = picked.choice !== NO_TOOL;
  if (wantsTool ? needs.noul < 0.3 : needs.noul > 0.7) {
    return { mode: "passthrough", reason: "jev_answers_disagree", jev };
  }

  if (!wantsTool) {
    return config.onNone === "force_none"
      ? { mode: "none", confidence: picked.confidence, jev }
      : { mode: "passthrough", reason: "no_tool_needed", jev };
  }

  const toolIndex = plans.findIndex((plan) => plan.name === picked.choice);
  const plan = plans[toolIndex];
  const tool = input.tools[toolIndex];
  if (!plan || !tool) return { mode: "passthrough", reason: "jev_unknown_tool", jev };
  // Provider-run tools can't be forced by name; knowing Jev wants one is still worth logging.
  if (tool.kind === "hosted") return { mode: "passthrough", reason: "hosted_tool_selected", jev };
  // Neither can namespaced ones: backends reject both `tool_choice.namespace` and the bare name.
  if (tool.namespace) return { mode: "passthrough", reason: "namespaced_tool_selected", jev };

  const resolved = plan.closedParams && resolveArgs(plan, toolIndex, result.answers, config.argMinCertainty);
  if (resolved) {
    return {
      mode: "direct",
      tool: plan.name,
      args: resolved.args,
      confidence: Math.min(picked.confidence, resolved.certainty),
      jev,
    };
  }
  return { mode: "forced", tool: plan.name, kind: tool.kind, confidence: picked.confidence, jev };
}

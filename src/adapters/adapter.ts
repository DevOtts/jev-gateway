import type { Decision } from "../decide.js";
import type { DirectCall, RouterInput } from "../types.js";

/** Translates one client wire format to and from the router's neutral shapes. */
export interface Adapter<Req extends { model?: string; stream?: boolean }> {
  /** What Jev should judge, or why this request isn't routable. */
  toInput(req: Req, maxMessageChars: number): RouterInput | { skip: string };
  /** Rewrite the request so the LLM only does the part of the work Jev left for it. */
  apply(req: Req, decision: Decision, argsModel?: string): Req;
  directJson(req: Req, call: DirectCall): object;
  directStream(req: Req, call: DirectCall): string;
}

export const sse = (events: { event?: string; data: string }[]): string =>
  events.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`).join("");

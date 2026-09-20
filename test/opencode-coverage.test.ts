import { describe, expect, it } from "vitest";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const { opencode, opencodeConfigContent, opencodeOutsideGateway } = await import("../bin/clients.mjs");

const origin = "http://127.0.0.1:8791";

/**
 * What `opencode debug config` printed (OpenCode 1.18.31) for a project whose opencode.json gives
 * `build` and `reviewer` a model, with a third agent defined in .opencode/agent/docs-writer.md,
 * started with the launcher's OPENCODE_CONFIG_CONTENT. Trimmed to the keys read here. The default
 * model is the gateway's, and every agent that named a model kept it.
 */
const resolved = {
  $schema: "https://opencode.ai/config.json",
  model: "jev-gateway/gpt-5",
  small_model: "jev-gateway/gpt-5",
  agent: {
    build: { model: "anthropic/claude-sonnet-4-5", options: {}, permission: {} },
    reviewer: { mode: "subagent", description: "Reviews code.", model: "openai/gpt-5", options: {}, permission: {} },
    "docs-writer": { name: "docs-writer", description: "Writes docs.", mode: "subagent", model: "xai/grok-4", prompt: "You write docs." },
  },
  provider: { "jev-gateway": {} },
};

describe("what jev-opencode says will not go through the gateway", () => {
  it("names every agent that selects another provider's model, however it was defined", () => {
    const lines = opencodeOutsideGateway(resolved) as string[];
    expect(lines.join("\n")).toContain('agent "build" (anthropic/claude-sonnet-4-5)');
    expect(lines.join("\n")).toContain('agent "reviewer" (openai/gpt-5)');
    expect(lines.join("\n")).toContain('agent "docs-writer" (xai/grok-4)');
  });

  it("says that agents without a model of their own are covered, so silence is not read as a gap", () => {
    expect((opencodeOutsideGateway(resolved) as string[]).at(-1)).toMatch(/without a model of their own use the default and are covered/);
  });

  it("has nothing to say when every agent uses the default or a gateway model", () => {
    const covered = { ...resolved, agent: { build: {}, plan: { model: "jev-gateway/gpt-5" }, general: { mode: "subagent" } } };
    expect(opencodeOutsideGateway(covered)).toEqual([]);
  });

  it("leaves disabled agents out: they will not run", () => {
    const config = { ...resolved, agent: { reviewer: { model: "openai/gpt-5", disable: true } } };
    expect(opencodeOutsideGateway(config)).toEqual([]);
  });

  it.each([
    [["-m", "anthropic/claude-sonnet-4-5"]],
    [["run", "--model", "anthropic/claude-sonnet-4-5", "fix it"]],
    [["--model=anthropic/claude-sonnet-4-5"]],
  ])("names a --model from another provider, which outranks the default: %j", (argv) => {
    const lines = opencodeOutsideGateway({ ...resolved, agent: {} }, argv) as string[];
    expect(lines.join("\n")).toContain("this session (--model anthropic/claude-sonnet-4-5)");
  });

  it("accepts a --model served by the gateway, and ignores one meant for the prompt after --", () => {
    expect(opencodeOutsideGateway({ ...resolved, agent: {} }, ["-m", "jev-gateway/gpt-5"])).toEqual([]);
    expect(opencodeOutsideGateway({ ...resolved, agent: {} }, ["run", "--", "-m", "openai/gpt-5"])).toEqual([]);
  });

  it("notices a default model that something outranking the launcher replaced", () => {
    const lines = opencodeOutsideGateway({ ...resolved, model: "openai/gpt-5", agent: {} }) as string[];
    expect(lines.join("\n")).toContain("the default model (openai/gpt-5)");
  });

  it("still reports --model when OpenCode could not be asked, and never throws on odd input", () => {
    expect((opencodeOutsideGateway(undefined, ["-m", "openai/gpt-5"]) as string[])[1]).toContain("--model openai/gpt-5");
    expect(opencodeOutsideGateway(undefined)).toEqual([]);
    expect(opencodeOutsideGateway({ ...resolved, agent: { broken: null, odd: { model: 7 } } })).toEqual([]);
  });

  it("can be switched off, without asking OpenCode anything", async () => {
    expect(await opencode.notices(origin, ["-m", "openai/gpt-5"], { JEV_OPENCODE_CHECK: "off" })).toEqual([]);
  });
});

describe("an OPENCODE_CONFIG_CONTENT the user already set", () => {
  const theirs = {
    model: "openai/gpt-5",
    permission: { bash: "ask" },
    agent: { reviewer: { mode: "subagent", model: "google/gemini-2.5-pro" } },
    provider: { local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:11434/v1" } } },
  };

  it("is kept, with the gateway's default models and provider laid over it", () => {
    const merged = JSON.parse(opencodeConfigContent(origin, JSON.stringify(theirs)));
    expect(merged.permission).toEqual(theirs.permission);
    expect(merged.agent).toEqual(theirs.agent);
    expect(merged.provider.local).toEqual(theirs.provider.local);
    expect(merged.provider["jev-gateway"].options.baseURL).toBe(`${origin}/v1`);
    expect(merged.model).toBe("jev-gateway/gpt-5");
    expect(merged.small_model).toBe("jev-gateway/gpt-5");
  });

  it("reaches the launched process through the spec's env", () => {
    const env = opencode.env(origin, { OPENCODE_CONFIG_CONTENT: JSON.stringify(theirs) });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission).toEqual(theirs.permission);
  });

  it.each(["", "   ", "not json", "[1, 2]", "null", '"text"'])("is replaced when it is %j, which OpenCode would refuse anyway", (content) => {
    const config = JSON.parse(opencodeConfigContent(origin, content));
    expect(Object.keys(config)).toEqual(["$schema", "model", "small_model", "provider"]);
  });
});

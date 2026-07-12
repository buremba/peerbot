import { describe, expect, test } from "bun:test";
import {
  LOBU_DEFAULT_IDENTITY,
  replaceBasePromptIdentity,
  resolveAgentIdentity,
} from "../openclaw/worker";

const PI_OPENER =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

describe("replaceBasePromptIdentity", () => {
  test("replaces the pi-coding-agent opener with agent identity, preserving the rest", () => {
    const base = `${PI_OPENER}\n\nAvailable tools:\n- read: Read file contents\n\nGuidelines:\n- Be concise`;
    const identity = "You are a healthcare operations assistant.";
    const out = replaceBasePromptIdentity(base, identity);

    expect(out.startsWith(identity)).toBe(true);
    expect(out).not.toContain("expert coding assistant");
    // Preserved harness footer
    expect(out).toContain("Available tools:");
    expect(out).toContain("Guidelines:");
  });

  test("falls back to prepending identity when upstream opener wording drifts", () => {
    const base =
      "You are some other intro that the upstream package switched to.\n\nAvailable tools:\n- read";
    const identity = "You are a healthcare operations assistant.";
    const out = replaceBasePromptIdentity(base, identity);

    expect(out.startsWith(identity)).toBe(true);
    // Original base prompt is still there (we didn't accidentally drop it)
    expect(out).toContain("Available tools:");
    expect(out).toContain("some other intro");
  });

  test("multi-line identity is inserted as a single block", () => {
    const base = `${PI_OPENER}\n\nAvailable tools:\n- read`;
    const identity =
      "You are a careops bot.\n\nYou speak only in plain English.";
    const out = replaceBasePromptIdentity(base, identity);

    expect(out.startsWith(identity)).toBe(true);
    expect(out).toContain("Available tools:");
  });
});

describe("resolveAgentIdentity", () => {
  test("uses the agent's own IDENTITY.md when present", () => {
    const identity = "You are Aria, Acme's support agent.";
    expect(resolveAgentIdentity(identity)).toBe(identity);
  });

  test("trims surrounding whitespace from a present identity", () => {
    expect(resolveAgentIdentity("  You are Aria.  \n")).toBe("You are Aria.");
  });

  test("falls back to the Lobu default when identity is empty", () => {
    expect(resolveAgentIdentity("")).toBe(LOBU_DEFAULT_IDENTITY);
    expect(resolveAgentIdentity("   \n  ")).toBe(LOBU_DEFAULT_IDENTITY);
    expect(resolveAgentIdentity(undefined)).toBe(LOBU_DEFAULT_IDENTITY);
  });

  test("the Lobu default never leaks the pi harness framing", () => {
    expect(LOBU_DEFAULT_IDENTITY).not.toContain("coding agent harness");
    // It may reference "coding assistant" only to disclaim it, never to
    // self-identify as one.
    expect(LOBU_DEFAULT_IDENTITY).not.toContain("You are an expert coding");
    expect(LOBU_DEFAULT_IDENTITY).toContain("not a generic coding assistant");
    // Grounds the agent in real Lobu capabilities, not a raw tool list.
    expect(LOBU_DEFAULT_IDENTITY).toContain("memory");
    expect(LOBU_DEFAULT_IDENTITY).toContain("connectors");
    expect(LOBU_DEFAULT_IDENTITY).toContain("Take action");
    expect(LOBU_DEFAULT_IDENTITY).toContain("permissions and guardrails");
    // Per-run specifics must be deferred to runtime context, never hardcoded.
    expect(LOBU_DEFAULT_IDENTITY).toContain("runtime context");
  });

  test("default identity replaces the pi opener end-to-end", () => {
    const base = `${PI_OPENER}\n\nAvailable tools:\n- read`;
    const out = replaceBasePromptIdentity(base, resolveAgentIdentity(""));
    expect(out).not.toContain("expert coding assistant");
    expect(out).toContain("Lobu agent");
    expect(out).toContain("Available tools:");
  });
});

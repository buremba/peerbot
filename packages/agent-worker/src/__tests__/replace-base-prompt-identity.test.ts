import { describe, expect, test } from "bun:test";
import { replaceBasePromptIdentity } from "../openclaw/worker";

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

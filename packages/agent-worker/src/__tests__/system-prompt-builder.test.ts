/**
 * Unit tests for the Lobu system prompt document.
 *
 * Delivery — that this document is what the model actually receives — is
 * covered by `system-prompt-delivery.test.ts`, which reads the outgoing
 * provider request. This file covers the document's shape.
 */
import { describe, expect, test } from "bun:test";
import {
  buildLobuSystemPrompt,
  createLobuSystemPromptRenderer,
  type LobuSystemPromptInput,
} from "../runtime/system-prompt";

const NOW = new Date(2026, 6, 29); // 2026-07-29, local time

function build(overrides: Partial<LobuSystemPromptInput> = {}): string {
  return buildLobuSystemPrompt({
    identity: "You are Aria.",
    gatewayInstructions: "## Platform: Slack",
    cwd: "/workspaces/agent-1",
    now: NOW,
    ...overrides,
  });
}

describe("buildLobuSystemPrompt", () => {
  test("renders identity, gateway tail and trailing facts in order", () => {
    expect(build()).toBe(
      "You are Aria.\n\n---\n\n## Platform: Slack\n\n" +
        "Current date: 2026-07-29\n" +
        "Current working directory: /workspaces/agent-1"
    );
  });

  test("omits the separator when there are no gateway instructions", () => {
    const out = build({ gatewayInstructions: "   \n  " });
    expect(out).not.toContain("---");
    expect(out.startsWith("You are Aria.\n\nCurrent date:")).toBe(true);
  });

  test("normalizes Windows-style separators in the working directory", () => {
    expect(build({ cwd: "C:\\workspaces\\agent-1" })).toContain(
      "Current working directory: C:/workspaces/agent-1"
    );
  });

  test("lists only tools that carry a snippet, in the given order", () => {
    const out = build({
      toolContext: {
        selectedTools: ["read", "search_memory", "bash"],
        toolSnippets: { read: "Read file contents", bash: "Execute bash" },
        promptGuidelines: [],
      },
    });
    expect(out).toContain(
      "Available tools:\n- read: Read file contents\n- bash: Execute bash"
    );
    // A tool with no registered shorthand is not assigned invented copy.
    expect(out).not.toContain("search_memory");
  });

  test("keeps pi's tool guidelines and appends Lobu's conduct rules after them", () => {
    const out = build({
      toolContext: {
        selectedTools: ["edit"],
        toolSnippets: { edit: "Edit files" },
        promptGuidelines: ["edits[].oldText must match exactly"],
      },
    });
    expect(out).toContain(
      "Guidelines:\n" +
        "- edits[].oldText must match exactly\n" +
        "- Be concise in your responses\n" +
        "- Show file paths clearly when working with files"
    );
  });

  test("de-duplicates a guideline pi already registered", () => {
    const out = build({
      toolContext: {
        selectedTools: ["read"],
        toolSnippets: { read: "Read file contents" },
        promptGuidelines: ["Be concise in your responses"],
      },
    });
    expect(out.split("Be concise in your responses").length - 1).toBe(1);
  });

  test("the file-exploration guideline follows the tools actually active", () => {
    const withSearchTools = build({
      toolContext: {
        selectedTools: ["bash", "grep"],
        toolSnippets: { bash: "Execute bash" },
        promptGuidelines: [],
      },
    });
    expect(withSearchTools).toContain("Prefer grep/find/ls tools over bash");

    // bash but nothing to prefer over it — the opposite advice, not a claim
    // about tools this agent was never given.
    const bashOnly = build({
      toolContext: {
        selectedTools: ["bash"],
        toolSnippets: { bash: "Execute bash" },
        promptGuidelines: [],
      },
    });
    expect(bashOnly).not.toContain("Prefer grep/find/ls");
    expect(bashOnly).toContain("Use bash for file operations");

    // No bash at all — neither guideline applies.
    const noBash = build({
      toolContext: {
        selectedTools: ["read"],
        toolSnippets: { read: "Read file contents" },
        promptGuidelines: [],
      },
    });
    expect(noBash).not.toContain("Prefer grep/find/ls");
    expect(noBash).not.toContain("Use bash for file operations");
  });

  test("an agent with no tools gets conduct rules but no tool claims", () => {
    const out = build({
      toolContext: {
        selectedTools: [],
        toolSnippets: {},
        promptGuidelines: [],
      },
    });
    expect(out).not.toContain("Available tools:");
    // Conduct applies regardless of tooling; anything about files does not.
    expect(out).toContain("Guidelines:\n- Be concise in your responses");
    expect(out).not.toContain("Show file paths");
  });

  test("the file-path rule appears for every file-capable tool", () => {
    const withReadTool = build({
      toolContext: {
        selectedTools: ["read"],
        toolSnippets: { read: "Read file contents" },
        promptGuidelines: [],
      },
    });
    expect(withReadTool).toContain("Show file paths clearly");

    const withBashTool = build({
      toolContext: {
        selectedTools: ["bash"],
        toolSnippets: { bash: "Execute bash" },
        promptGuidelines: [],
      },
    });
    expect(withBashTool).toContain("Show file paths clearly");
  });
});

describe("createLobuSystemPromptRenderer", () => {
  test("renders a base fragment for pi and a complete per-turn document", () => {
    const render = createLobuSystemPromptRenderer({
      identity: "You are Aria.",
      gatewayInstructions: "## Platform: Slack",
      cwd: "/workspaces/agent-1",
    });

    const withoutTools = render();
    const withTools = render({
      selectedTools: ["read"],
      toolSnippets: { read: "Read file contents" },
      promptGuidelines: [],
    });

    expect(withoutTools.startsWith("You are Aria.")).toBe(true);
    expect(withoutTools).toContain("## Platform: Slack");
    expect(withoutTools).not.toContain("Available tools:");
    // Pi adds these to its custom-prompt input while assembling the base.
    expect(withoutTools).not.toContain("Current date:");
    expect(withoutTools).not.toContain("Current working directory:");

    expect(withTools.startsWith("You are Aria.")).toBe(true);
    expect(withTools).toContain("## Platform: Slack");
    expect(withTools).toContain("- read: Read file contents");
    expect(withTools).toContain(
      "Current working directory: /workspaces/agent-1"
    );
  });

  test("stamps the date at render time, not when the session was built", () => {
    const render = createLobuSystemPromptRenderer({
      identity: "You are Aria.",
      gatewayInstructions: "",
      cwd: "/workspaces/agent-1",
    });
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(
      render({
        selectedTools: [],
        toolSnippets: {},
        promptGuidelines: [],
      })
    ).toContain(`Current date: ${expected}`);
  });
});

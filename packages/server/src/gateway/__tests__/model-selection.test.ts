import { describe, expect, mock, test } from "bun:test";
import {
  composeEffectiveModelRef,
  resolveEffectiveModelRef,
} from "../auth/settings/model-selection.js";

describe("resolveEffectiveModelRef (agent layer)", () => {
  test("returns the agent's defaultModel", () => {
    expect(resolveEffectiveModelRef({ defaultModel: "openai/gpt-5" })).toBe(
      "openai/gpt-5",
    );
  });

  test("preserves the literal 'auto'", () => {
    expect(resolveEffectiveModelRef({ defaultModel: "auto" })).toBe("auto");
  });

  test("undefined when the agent pins nothing", () => {
    expect(resolveEffectiveModelRef({ defaultModel: "  " })).toBeUndefined();
    expect(resolveEffectiveModelRef({})).toBeUndefined();
    expect(resolveEffectiveModelRef(null)).toBeUndefined();
  });
});

describe("composeEffectiveModelRef (agent → org fallback)", () => {
  test("agent defaultModel wins over the org default", async () => {
    const readOrg = mock(async () => "claude/claude-sonnet-4-6");
    expect(
      await composeEffectiveModelRef(
        { defaultModel: "openai/gpt-5" },
        "org-1",
        readOrg,
      ),
    ).toBe("openai/gpt-5");
    // Agent pinned a model, so the org lookup is short-circuited.
    expect(readOrg).not.toHaveBeenCalled();
  });

  test("falls through to the org default when the agent pins nothing", async () => {
    const readOrg = mock(async () => "claude/claude-sonnet-4-6");
    expect(await composeEffectiveModelRef({}, "org-1", readOrg)).toBe(
      "claude/claude-sonnet-4-6",
    );
    expect(readOrg).toHaveBeenCalledWith("org-1");
  });

  test("undefined when neither agent nor org has a model (worker throws)", async () => {
    const readOrg = mock(async () => null);
    expect(await composeEffectiveModelRef({}, "org-1", readOrg)).toBeUndefined();
  });

  test("skips the org lookup entirely when organizationId is absent", async () => {
    const readOrg = mock(async () => "claude/claude-sonnet-4-6");
    expect(await composeEffectiveModelRef({}, undefined, readOrg)).toBeUndefined();
    expect(readOrg).not.toHaveBeenCalled();
  });
});

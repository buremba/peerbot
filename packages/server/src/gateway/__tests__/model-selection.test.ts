import { describe, expect, mock, test } from "bun:test";
import {
  composeEffectiveModelRef,
  enforceModelAllowList,
  resolveEffectiveModelRef,
} from "../auth/settings/model-selection.js";

describe("enforceModelAllowList (universal dispatch gate — decision A/B)", () => {
  test("#1: an out-of-list model on a LISTED provider is REPLACED with the first listed real model", () => {
    // models=["openai/gpt-5"], requested "openai/gpt-4o" (same provider, diff
    // model). This is the exact direct-API / watcher / schedule bypass case.
    const r = enforceModelAllowList("openai/gpt-4o", ["openai/gpt-5"]);
    expect(r.replaced).toBe(true);
    expect(r.model).toBe("openai/gpt-5");
  });

  test("#1: a stale session.model no longer in the list is replaced", () => {
    const r = enforceModelAllowList("claude/old-model", [
      "openai/gpt-5",
      "claude/claude-sonnet-5",
    ]);
    expect(r.model).toBe("openai/gpt-5"); // first listed real model
    expect(r.replaced).toBe(true);
  });

  test("an EXACT listed ref passes unchanged", () => {
    const r = enforceModelAllowList("claude/claude-sonnet-5", [
      "openai/gpt-5",
      "claude/claude-sonnet-5",
    ]);
    expect(r.model).toBe("claude/claude-sonnet-5");
    expect(r.replaced).toBe(false);
  });

  test("allow-all (null) passes any well-formed model unchanged", () => {
    const r = enforceModelAllowList("anything/goes", null);
    expect(r.model).toBe("anything/goes");
    expect(r.replaced).toBe(false);
  });

  test("#2: a sentinel-only list HARD-FAILS CLOSED (model dropped, never escalates)", () => {
    const r = enforceModelAllowList("chatgpt/gpt-4o", [
      "chatgpt/__unresolved__",
    ]);
    // No real listed model → model dropped (undefined) → run fails closed.
    expect(r.model).toBeUndefined();
    expect(r.replaced).toBe(true);
  });

  test("#2: an all-sentinel list requested-sentinel is dropped (never routes)", () => {
    const r = enforceModelAllowList("chatgpt/__unresolved__", [
      "chatgpt/__unresolved__",
    ]);
    expect(r.model).toBeUndefined();
  });

  test("#2 mixed-list: a requested SENTINEL default resolves to the listed REAL alternate", () => {
    // models=["unknown/__unresolved__","openai/gpt-4o"], the agent default is
    // the sentinel — it must resolve to the real listed alternate, NOT undefined.
    const r = enforceModelAllowList("unknown/__unresolved__", [
      "unknown/__unresolved__",
      "openai/gpt-4o",
    ]);
    expect(r.model).toBe("openai/gpt-4o");
    expect(r.replaced).toBe(true);
  });

  test("#2 mixed-list: an OUT-OF-LIST model resolves to the first REAL listed ref (skips leading sentinel)", () => {
    const r = enforceModelAllowList("claude/old", [
      "ghost/__unresolved__",
      "openai/gpt-4o",
    ]);
    expect(r.model).toBe("openai/gpt-4o");
  });

  test("#4 ROUTABILITY: replacement picks the first non-sentinel ROUTABLE ref, not just non-sentinel", () => {
    // allow=["xai/grok-4","openai/gpt-5"], xai UNCREDENTIALED. A disallowed
    // request must replace onto openai/gpt-5 (routable), NOT dead xai/grok-4.
    const isRoutable = (ref: string) => ref === "openai/gpt-5";
    const r = enforceModelAllowList(
      "claude/forbidden",
      ["xai/grok-4", "openai/gpt-5"],
      isRoutable,
    );
    expect(r.model).toBe("openai/gpt-5");
    expect(r.model).not.toBe("xai/grok-4");
  });

  test("#4 ROUTABILITY: fails closed when NO listed ref is routable", () => {
    const r = enforceModelAllowList(
      "claude/forbidden",
      ["xai/grok-4", "openai/gpt-5"],
      () => false,
    );
    expect(r.model).toBeUndefined();
    expect(r.replaced).toBe(true);
  });

  test("#4: without a routability predicate, falls back to first NON-SENTINEL (structural only)", () => {
    const r = enforceModelAllowList("claude/forbidden", [
      "xai/grok-4",
      "openai/gpt-5",
    ]);
    expect(r.model).toBe("xai/grok-4");
  });

  test("R5 #1: an EXACT-LISTED but UNROUTABLE request is replaced onto the first routable listed ref", () => {
    // allow=["xai/grok-4","openai/gpt-5"], xai UNCREDENTIALED, requested exactly
    // "xai/grok-4" (in the list) — the includes-branch must NOT short-circuit
    // past routability; it replaces onto openai/gpt-5.
    const isRoutable = (ref: string) => ref === "openai/gpt-5";
    const r = enforceModelAllowList(
      "xai/grok-4",
      ["xai/grok-4", "openai/gpt-5"],
      isRoutable,
    );
    expect(r.model).toBe("openai/gpt-5");
    expect(r.replaced).toBe(true);
  });

  test("R5 #1: an EXACT-LISTED but UNROUTABLE request with NO other routable ref fails closed", () => {
    const r = enforceModelAllowList("xai/grok-4", ["xai/grok-4"], () => false);
    expect(r.model).toBeUndefined();
    expect(r.replaced).toBe(true);
  });

  test("R5 #1: an EXACT-LISTED ROUTABLE request still passes unchanged", () => {
    const r = enforceModelAllowList(
      "openai/gpt-5",
      ["xai/grok-4", "openai/gpt-5"],
      (ref) => ref === "openai/gpt-5",
    );
    expect(r.model).toBe("openai/gpt-5");
    expect(r.replaced).toBe(false);
  });

  test("R5 #2: DENY-ALL (allowedRefs=[]) drops any requested model (fail closed)", () => {
    const r = enforceModelAllowList("openai/gpt-5", []);
    expect(r.model).toBeUndefined();
    expect(r.replaced).toBe(true);
  });

  test("undefined requested model stays undefined", () => {
    expect(enforceModelAllowList(undefined, ["openai/gpt-5"]).model).toBeUndefined();
  });
});

describe("resolveEffectiveModelRef (agent layer)", () => {
  test("returns the head of the agent's models list", () => {
    expect(
      resolveEffectiveModelRef({ models: ["openai/gpt-5", "claude/claude-sonnet-5"] }),
    ).toBe("openai/gpt-5");
  });

  test("undefined when the agent pins nothing", () => {
    expect(resolveEffectiveModelRef({ models: ["  "] })).toBeUndefined();
    expect(resolveEffectiveModelRef({ models: [] })).toBeUndefined();
    expect(resolveEffectiveModelRef({})).toBeUndefined();
    expect(resolveEffectiveModelRef(null)).toBeUndefined();
  });
});

describe("composeEffectiveModelRef (agent → org fallback)", () => {
  test("agent models[0] wins over the org default", async () => {
    const readOrg = mock(async () => "claude/claude-sonnet-4-6");
    expect(
      await composeEffectiveModelRef(
        { models: ["openai/gpt-5"] },
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

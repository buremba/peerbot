import { describe, expect, test } from "bun:test";
import { parseVerdict } from "../proxy/egress-judge/anthropic-client.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
} from "../proxy/egress-judge/policy-composer.js";

describe("buildSystemPrompt", () => {
  test("includes the required JSON output schema", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"allow"');
    expect(prompt).toContain('"deny"');
    expect(prompt).toContain('"reason"');
  });

  test("directs the judge to fail closed on ambiguity", () => {
    expect(buildSystemPrompt().toLowerCase()).toContain("fail closed");
  });
});

describe("buildUserPrompt", () => {
  test("includes the agent id, policy, and full request context", () => {
    const prompt = buildUserPrompt({
      policy: "Allow only GET to GitHub.",
      request: {
        agentId: "my-agent",
        hostname: "api.github.com",
        method: "GET",
        path: "/repos/lobu-ai/lobu",
      },
    });
    expect(prompt).toContain("my-agent");
    expect(prompt).toContain("Allow only GET to GitHub.");
    expect(prompt).toContain("api.github.com");
    expect(prompt).toContain("method: GET");
    expect(prompt).toContain("path: /repos/lobu-ai/lobu");
  });

  test("marks HTTPS CONNECT so the judge knows method/path are opaque", () => {
    const prompt = buildUserPrompt({
      policy: "x",
      request: { agentId: "a", hostname: "x.com" },
    });
    expect(prompt.toLowerCase()).toContain("connect");
    expect(prompt.toLowerCase()).toContain("opaque");
  });
});

describe("parseVerdict", () => {
  test("accepts a clean allow verdict", () => {
    expect(
      parseVerdict(
        JSON.stringify({ verdict: "allow", reason: "within policy" })
      )
    ).toEqual({ verdict: "allow", reason: "within policy" });
  });

  test("accepts a clean deny verdict", () => {
    expect(
      parseVerdict(
        JSON.stringify({ verdict: "deny", reason: "unknown domain" })
      )
    ).toEqual({ verdict: "deny", reason: "unknown domain" });
  });

  test("strips surrounding code fences", () => {
    const raw = '```json\n{"verdict":"allow","reason":"ok"}\n```';
    expect(parseVerdict(raw)).toEqual({ verdict: "allow", reason: "ok" });
  });

  test("supplies a placeholder reason when the model omits one", () => {
    expect(parseVerdict(JSON.stringify({ verdict: "allow" }))).toEqual({
      verdict: "allow",
      reason: "(no reason given)",
    });
  });

  test("throws when verdict is not allow/deny", () => {
    expect(() =>
      parseVerdict(JSON.stringify({ verdict: "maybe", reason: "x" }))
    ).toThrow();
  });

  test("throws on non-JSON output", () => {
    expect(() => parseVerdict("not json at all")).toThrow();
  });

  test("throws when the response is an array instead of an object", () => {
    expect(() => parseVerdict("[]")).toThrow();
  });

  test("extracts JSON from prose when the judge ignores the fixed format", () => {
    const raw =
      'Here is my analysis. The request looks fine: {"verdict":"allow","reason":"ok"}. Done.';
    expect(parseVerdict(raw)).toEqual({ verdict: "allow", reason: "ok" });
  });

  test("handles unfenced JSON with leading/trailing whitespace", () => {
    const raw = '\n\n  {"verdict":"deny","reason":"off-policy"}  \n';
    expect(parseVerdict(raw)).toEqual({
      verdict: "deny",
      reason: "off-policy",
    });
  });

  test("still rejects prose with no verdict JSON at all", () => {
    expect(() =>
      parseVerdict("I am unable to decide without more context.")
    ).toThrow();
  });
});

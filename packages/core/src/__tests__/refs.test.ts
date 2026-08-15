/**
 * Tests for the shared ref-token codec.
 *
 * This module is consumed by BOTH the server (`automations/source-refs.ts`) and
 * the SPA (`owletto/src/lib/references.ts`). Before consolidation each side
 * carried its own transcription of the grammar, and the failure mode of a
 * mismatch is silent: a token the regex does not match is skipped, so the
 * caller receives `[]` and never an error. The kind-group cases below are the
 * regression guard for exactly that.
 */

import { describe, expect, it } from "bun:test";
import {
  automationSourcesFromPrompt,
  automationSourcesWithRef,
  mergePromptSources,
  parseRefs,
  serializeRef,
  skillNamesFromPrompt,
  sqlQueryFromPath,
  sqlRefPath,
  stripRefTokens,
} from "../refs";

describe("ref token grammar", () => {
  it("round-trips a ref through serialize and parse", () => {
    const ref = {
      kind: "feed" as const,
      id: "issues",
      label: "GitHub Issues",
      path: "/acme/connectors/github/7",
    };
    expect(parseRefs(serializeRef(ref))).toEqual([ref]);
  });

  it("lexes a kind containing an underscore", () => {
    // Narrowing the kind group to [a-z]+ makes this return [] rather than
    // throwing, which is how an entire chip kind disappears unnoticed.
    const parsed = parseRefs("@[entity_type:company:Companies](/acme/company)");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.kind).toBe("entity_type");
    expect(parsed[0]?.id).toBe("company");
  });

  it("strips every token kind, underscored ones included", () => {
    const prompt =
      "watch @[entity_type:company:Companies](/acme/company) and " +
      "@[feed:issues:Issues](/acme/f) closely";
    expect(stripRefTokens(prompt)).toBe("watch   and   closely");
  });

  it("skips unknown kinds instead of throwing", () => {
    expect(parseRefs("@[nonsense:1:X](/a) @[feed:k:F](/b)")).toHaveLength(1);
  });
});

describe("sql payload codec", () => {
  it("survives parens, quotes and newlines through the token path group", () => {
    const query =
      "SELECT id\nFROM events\nWHERE ts > now() - interval '7 days'";
    const path = sqlRefPath(query);
    expect(path).not.toContain(")");
    expect(path).not.toContain(" ");
    expect(sqlQueryFromPath(path)).toBe(query);
  });

  it("returns null for a navigable path", () => {
    expect(sqlQueryFromPath("/acme/company/spotify")).toBeNull();
  });
});

describe("automationSourcesFromPrompt", () => {
  it("compiles entity_type to the @entity: type-slug mode", () => {
    expect(
      automationSourcesFromPrompt(
        "@[entity_type:company:Companies](/acme/company)"
      )
    ).toEqual([{ name: "companies", query: "@entity:company" }]);
  });

  it("excludes an entity INSTANCE while including the type", () => {
    const prompt =
      "@[entity:42:Spotify](/acme/company/spotify) " +
      "@[entity_type:company:Companies](/acme/company)";
    expect(automationSourcesFromPrompt(prompt)).toEqual([
      { name: "companies", query: "@entity:company" },
    ]);
  });

  it("decodes a sql chip and de-dupes by query with unique names", () => {
    const query = "SELECT id FROM events";
    const prompt = [
      "@[feed:k1:Issues](/a)",
      "@[feed:k1:Issues again](/a)",
      "@[feed:k2:Issues](/b)",
      `@[sql:recent:Recent](${sqlRefPath(query)})`,
    ].join(" ");
    expect(automationSourcesFromPrompt(prompt)).toEqual([
      { name: "issues", query: "@feed:k1" },
      { name: "issues_2", query: "@feed:k2" },
      { name: "recent", query },
    ]);
  });

  it("never treats a skill chip as a source", () => {
    expect(automationSourcesFromPrompt("@[skill:triage:triage](/a)")).toEqual(
      []
    );
    expect(skillNamesFromPrompt("@[skill:triage:triage](/a)")).toEqual([
      "triage",
    ]);
  });
});

describe("automationSourcesWithRef", () => {
  it("appends an entity_type ref and leaves an existing duplicate alone", () => {
    const first = automationSourcesWithRef(
      {
        kind: "entity_type",
        id: "company",
        label: "Companies",
        path: "/acme/company",
      },
      []
    );
    expect(first).toEqual([{ name: "companies", query: "@entity:company" }]);

    const again = automationSourcesWithRef(
      {
        kind: "entity_type",
        id: "company",
        label: "Companies",
        path: "/acme/company",
      },
      first
    );
    expect(again).toEqual(first);
  });
});

describe("mergePromptSources", () => {
  it("keeps explicit sources first and suffixes colliding prompt names", () => {
    expect(
      mergePromptSources(
        [{ name: "slack", query: "@feed:a" }],
        [
          { name: "slack", query: "@connection:7" },
          { name: "dupe", query: "@feed:a" },
        ]
      )
    ).toEqual([
      { name: "slack", query: "@feed:a" },
      { name: "slack_2", query: "@connection:7" },
    ]);
  });
});

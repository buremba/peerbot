/**
 * Cross-side guard: SPA-accepted interaction-envelope literals must match the
 * core TypeBox contract. Owletto is a git submodule and cannot import server
 * packages at build time in every CI configuration, so we parse the SPA wire
 * check sites with a regex (same pattern as subdomain-reserved-parity).
 *
 * A literal added only in core (or only in the SPA) fails this test — the
 * recurrence-preventer for the resourceKind/attribution drift bug.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  APPROVAL_ATTRIBUTIONS,
  INTERACTION_RESOURCE_KINDS,
} from "../contracts/interaction-envelope";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** SPA files that hard-code accepted resourceKind / attribution wire values. */
const SPA_WIRE_FILES = [
  "packages/owletto/src/components/agents/agent-thread.tsx",
  "packages/owletto/src/lib/api/runs.ts",
  "packages/owletto/src/lib/api/agents.ts",
] as const;

function extractQuotedLiterals(
  source: string,
  field: "resourceKind" | "attribution"
): string[] {
  const found = new Set<string>();

  // Comparisons: resourceKind === "behavior", attribution !== 'agent'
  const cmp = new RegExp(`${field}\\s*(?:===|!==)\\s*['"]([^'"]+)['"]`, "g");
  for (const m of source.matchAll(cmp)) {
    found.add(m[1]!);
  }

  // Type / JSDoc unions: resourceKind: 'agent' | 'behavior' | null
  // Also: attribution: 'agent' | 'behavior'
  const union = new RegExp(
    `${field}\\??\\s*:\\s*((?:['"][^'"]+['"]\\s*\\|\\s*)*['"][^'"]+['"](?:\\s*\\|\\s*null)?)`,
    "g"
  );
  for (const m of source.matchAll(union)) {
    for (const lit of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) {
      if (lit[1] !== "null") found.add(lit[1]!);
    }
  }

  // JSDoc-only forms: attribution: 'agent' | 'behavior'.
  const jsdoc = new RegExp(
    `${field}[^\\n]*?((?:['"][^'"]+['"]\\s*\\|\\s*)+['"][^'"]+['"])`,
    "g"
  );
  for (const m of source.matchAll(jsdoc)) {
    for (const lit of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) {
      found.add(lit[1]!);
    }
  }

  return [...found].sort();
}

function loadSpaLiterals(
  field: "resourceKind" | "attribution"
): string[] | null {
  const found = new Set<string>();
  let anyFile = false;
  for (const rel of SPA_WIRE_FILES) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    anyFile = true;
    for (const lit of extractQuotedLiterals(readFileSync(abs, "utf8"), field)) {
      found.add(lit);
    }
  }
  if (!anyFile) return null; // submodule not checked out
  return [...found].sort();
}

describe("interaction-envelope SPA/core parity", () => {
  it("SPA resourceKind literals match INTERACTION_RESOURCE_KINDS", () => {
    const spa = loadSpaLiterals("resourceKind");
    if (spa === null) return; // skip when owletto is a stub
    expect(spa).toEqual([...INTERACTION_RESOURCE_KINDS].sort());
  });

  it("SPA attribution literals match APPROVAL_ATTRIBUTIONS", () => {
    const spa = loadSpaLiterals("attribution");
    if (spa === null) return;
    expect(spa).toEqual([...APPROVAL_ATTRIBUTIONS].sort());
  });

  it("core contract exports the expected canonical sets", () => {
    // Pin the wire values so a silent rename in the const array is a test fail.
    expect([...INTERACTION_RESOURCE_KINDS]).toEqual([
      "agent",
      "behavior",
      "entity",
    ]);
    expect([...APPROVAL_ATTRIBUTIONS]).toEqual(["agent", "behavior"]);
  });
});

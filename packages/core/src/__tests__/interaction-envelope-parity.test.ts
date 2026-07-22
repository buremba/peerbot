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
  isApprovalAttribution,
  isInteractionResourceKind,
} from "../contracts/interaction-envelope";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** SPA files that hard-code accepted resourceKind / attribution wire values. */
const SPA_WIRE_FILES = [
  "packages/owletto/src/components/agents/agent-thread.tsx",
  "packages/owletto/src/lib/api/runs.ts",
  "packages/owletto/src/lib/api/agents.ts",
] as const;

/**
 * Blank out // and block comments, preserving newlines. JSDoc must NOT count as
 * SPA support: a docblock saying `"agent" | "behavior"` while the code handles
 * neither would otherwise satisfy this test (verified — deleting the SPA's only
 * `attribution === "behavior"` branch still passed before this was added).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

function extractQuotedLiterals(
  raw: string,
  field: "resourceKind" | "attribution"
): string[] {
  const found = new Set<string>();
  const source = stripComments(raw);

  // Comparisons: resourceKind === "behavior", attribution !== 'agent'
  const cmp = new RegExp(`${field}\\s*(?:===|!==)\\s*['"]([^'"]+)['"]`, "g");
  for (const m of source.matchAll(cmp)) {
    found.add(m[1]!);
  }

  // Type unions: resourceKind: 'agent' | 'behavior' | null
  const union = new RegExp(
    `${field}\\??\\s*:\\s*((?:['"][^'"]+['"]\\s*\\|\\s*)*['"][^'"]+['"](?:\\s*\\|\\s*null)?)`,
    "g"
  );
  for (const m of source.matchAll(union)) {
    for (const lit of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) {
      if (lit[1] !== "null") found.add(lit[1]!);
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
    // The SPA declares the full union on the field type (agent | behavior) and
    // branches explicitly on behavior. Requiring the whole set — from code, not
    // JSDoc — is what makes a one-sided rename fail here.
    expect(spa).toEqual([...APPROVAL_ATTRIBUTIONS].sort());
  });

  it("core contract exports the expected canonical sets", () => {
    // Pin the wire values so a silent rename in the constants is a test fail.
    expect([...INTERACTION_RESOURCE_KINDS]).toEqual([
      "agent",
      "behavior",
      "entity",
    ]);
    expect([...APPROVAL_ATTRIBUTIONS]).toEqual(["agent", "behavior"]);
    expect(isInteractionResourceKind("behavior")).toBe(true);
    expect(isInteractionResourceKind("watcher")).toBe(false);
    expect(isApprovalAttribution("agent")).toBe(true);
    expect(isApprovalAttribution("watcher")).toBe(false);
  });
});

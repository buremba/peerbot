/**
 * `prompts/review-output-schema.json` is handed to BOTH reviewer CLIs by
 * `scripts/review.sh` — `claude --json-schema "$(cat …)"` and `codex exec
 * --output-schema …`. The two accept overlapping but not identical dialects,
 * and `review.sh` fails closed: a schema either CLI rejects produces no
 * verdict, `finalize_review_status error`, and a red `pi-review` status. That
 * check is required with `enforce_admins` on, so a one-key schema edit can
 * block every merge in the repo.
 *
 * That is exactly what happened. The file opened with
 *
 *   "$schema": "https://json-schema.org/draft/2020-12/schema"
 *
 * and `claude --json-schema` cannot resolve that meta-schema reference:
 *
 *   Error: --json-schema is not a valid JSON Schema: no schema with key or
 *   ref "https://json-schema.org/draft/2020-12/schema"
 *
 * It exits before reading the prompt, so the failure looks like a dead
 * reviewer rather than a bad key. codex accepts the file either way, so the
 * repo ran for as long as codex was the selected reviewer and only broke on
 * the fallback — the worst shape for a gate, because it is discovered under a
 * quota outage when there is no second reviewer to fall back to.
 *
 * The keys asserted here are the ones whose absence a reviewer only reports
 * as "no schema-valid JSON verdict", which reads as a model failure and sends
 * the next person to re-run the review instead of to this file.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCHEMA_FILE = join(REPO_ROOT, "prompts/review-output-schema.json");

/**
 * Keys that make `claude --json-schema` refuse the file outright. A dialect
 * declaration is optional metadata for both CLIs — neither infers anything
 * from it — so removing it costs nothing and dropping it from the whitelist
 * is the whole fix.
 */
function unsupportedKeys(schema: Record<string, unknown>): string[] {
  return ["$schema", "$id", "$ref", "$defs"].filter((key) => key in schema);
}

/**
 * `required` naming a property that does not exist is the other way this file
 * fails closed: codex's structured-output mode rejects the schema, and the
 * error surfaces as an empty verdict rather than as a schema complaint.
 */
function danglingRequired(schema: {
  required?: string[];
  properties?: Record<string, unknown>;
}): string[] {
  const properties = schema.properties ?? {};
  return (schema.required ?? []).filter((name) => !(name in properties));
}

describe("review output schema stays loadable by both reviewer CLIs", () => {
  const raw = readFileSync(SCHEMA_FILE, "utf8");
  const schema = JSON.parse(raw) as Record<string, any>;

  it("declares no meta-schema reference claude cannot resolve", () => {
    expect(unsupportedKeys(schema)).toEqual([]);
  });

  it("flags the draft-2020-12 declaration that broke the claude reviewer", () => {
    expect(
      unsupportedKeys({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
      })
    ).toEqual(["$schema"]);
  });

  it("requires only properties it defines", () => {
    expect(danglingRequired(schema)).toEqual([]);
  });

  it("flags a required name with no matching property", () => {
    expect(
      danglingRequired({
        required: ["bugs", "typo_field"],
        properties: { bugs: { type: "number" } },
      })
    ).toEqual(["typo_field"]);
  });

  it("keeps the closed-object shape codex's structured output needs", () => {
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("still carries the fields review.sh reads out of the verdict", () => {
    // review.sh pipes the verdict through `jq -r .<field>` and validates each
    // one before posting the status; a field dropped here fails the gate for
    // every PR, not just the one that dropped it.
    for (const field of [
      "bug_free_confidence",
      "bugs",
      "slop",
      "simplicity",
      "blockers",
      "change_type",
      "behavior_change_risk",
      "tests_adequate",
      "suggested_fixes",
      "notes",
      "categories",
    ]) {
      expect(schema.required).toContain(field);
    }
  });
});

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ENTITY_CHANGE_ACTION_KEYS } from "../../../tools/admin/entity-field-approval";

/**
 * describePendingApproval excludes the Automation's own entity-change review
 * artifacts, and spells their action keys out as a SQL literal rather than
 * importing ENTITY_CHANGE_ACTION_KEYS: that import pulls the entity-write
 * graph into a module the runs queue loads. Its comment asks the two to stay
 * in step and nothing enforced it, so a key added to the list would silently
 * stop being excluded and start failing headless Automation runs on their own
 * review artifacts.
 *
 * A test can import both, so the binding lives here instead of in the module.
 */
describe("entity-change action keys stay bound to their SQL literal", () => {
  it("matches the literal in describePendingApproval", () => {
    const source = readFileSync(
      new URL("../../../automations/run-completion.ts", import.meta.url),
      "utf8"
    );
    const match = source.match(
      /action_key = ANY\('\{([^}]*)\}'::text\[\]\)/
    );
    expect(match).not.toBeNull();
    const inLiteral = (match?.[1] ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .sort();
    expect(inLiteral).toEqual([...ENTITY_CHANGE_ACTION_KEYS].sort());
  });
});

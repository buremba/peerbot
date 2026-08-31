import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { ManageAutomationsSchema } from "../contracts/tools/manage-automations";
import { ListAction } from "../contracts/tools/manage-connections";
import { ManageEntitySchema } from "../contracts/tools/manage-entity";
import { ListFeedsAction } from "../contracts/tools/manage-feeds";
import {
  ListAvailableAction,
  ListRunsAction,
} from "../contracts/tools/manage-operations";

const listSchemas = [
  [ListAction, { action: "list" }],
  [ListFeedsAction, { action: "list_feeds" }],
  [ListAvailableAction, { action: "list_available" }],
  [ListRunsAction, { action: "list_runs" }],
  [ManageEntitySchema, { action: "list" }],
] as const;

describe("shared offset-pagination contracts", () => {
  test.each(listSchemas)("accepts bounded integer pages", (schema, base) => {
    expect(Value.Check(schema, { ...base, limit: 1, offset: 0 })).toBe(true);
    expect(Value.Check(schema, { ...base, limit: 500, offset: 10 })).toBe(true);
  });

  test.each(listSchemas)("rejects invalid page values", (schema, base) => {
    for (const pagination of [
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: 501 },
      { offset: -1 },
      { offset: 0.5 },
      { offset: 1_000_001 },
    ]) {
      expect(Value.Check(schema, { ...base, ...pagination })).toBe(false);
    }
  });
});

describe("manage_automations list limit", () => {
  test("accepts bounded integers and rejects fractional or unbounded values", () => {
    expect(
      Value.Check(ManageAutomationsSchema, { action: "list", limit: 1 })
    ).toBe(true);
    expect(
      Value.Check(ManageAutomationsSchema, { action: "list", limit: 500 })
    ).toBe(true);
    for (const limit of [0, -1, 1.5, 501]) {
      expect(
        Value.Check(ManageAutomationsSchema, { action: "list", limit })
      ).toBe(false);
    }
  });
});

describe("list_runs keyset cursor ID", () => {
  test("accepts positive integers and rejects invalid IDs", () => {
    const cursor = { before_created_at: "2026-08-31T12:00:00Z" };
    expect(
      Value.Check(ListRunsAction, {
        action: "list_runs",
        before_id: 1,
        ...cursor,
      })
    ).toBe(true);
    for (const before_id of [0, -1, 1.5]) {
      expect(
        Value.Check(ListRunsAction, {
          action: "list_runs",
          before_id,
          ...cursor,
        })
      ).toBe(false);
    }
  });
});

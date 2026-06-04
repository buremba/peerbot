import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { manageViewTemplates } from "../../../tools/admin/manage_view_templates";
import { closeDbSingleton } from "../../../db/client";
import { ToolUserError } from "../../../utils/errors";
import type { ToolContext } from "../../../tools/registry";

/**
 * Unit guard for the viewTemplates SDK path. A bad-shaped `get` call
 * (`{ resource: 'entity' }` instead of `{ resource_type, resource_id }`) used to
 * reach Postgres as `WHERE id = Number(undefined)` → `NaN` → a raw
 * `invalid input syntax for type bigint: "NaN"` error, because neither the SDK
 * namespace dispatcher (action-call.ts) nor the REST/registry path
 * (execute.ts only validates query_sdk/run_sdk) runs the TypeBox schema before
 * the handler. The handler now rejects the bad shape with a clean ToolUserError
 * BEFORE any DB query, so this test needs no live Postgres: the guard fires
 * before the (lazy) postgres.js client ever connects.
 */

// Point at a refused port so any query that *does* slip past the guard fails
// fast (ECONNREFUSED) instead of hanging — and never touches a real database.
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const ctx: ToolContext = {
  organizationId: "test-org",
  userId: "test-user",
  memberRole: "owner",
  isAuthenticated: true,
  tokenType: "oauth",
  scopedToOrg: false,
  allowCrossOrg: true,
};

beforeAll(async () => {
  // Reset any singleton built from a real URL, then bind a non-connecting one.
  await closeDbSingleton();
  process.env.DATABASE_URL = "postgres://localhost:1/none";
});

afterAll(async () => {
  await closeDbSingleton();
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

describe("manage_view_templates arg validation", () => {
  it("rejects a missing resource_type/resource_id with a clean ToolUserError (no Postgres NaN)", async () => {
    let caught: unknown;
    try {
      // The exact bad shape from the audit: `{ resource: 'entity' }`.
      await manageViewTemplates(
        { action: "get", resource: "entity" } as never,
        undefined,
        ctx,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const message = (caught as Error).message;
    expect(message).toMatch(/resource_type/);
    // Must NOT be the raw Postgres error.
    expect(message).not.toMatch(/NaN/);
    expect(message).not.toMatch(/invalid input syntax/);
  });

  it("rejects a non-numeric resource_id on the entity branch with a clean ToolUserError", async () => {
    let caught: unknown;
    try {
      await manageViewTemplates(
        { action: "get", resource_type: "entity", resource_id: "not-a-number" } as never,
        undefined,
        ctx,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const message = (caught as Error).message;
    expect(message).toMatch(/resource_id/);
    expect(message).not.toMatch(/NaN/);
    expect(message).not.toMatch(/invalid input syntax/);
  });

  it("rejects entity_type get with a missing resource_id before any DB query", async () => {
    // entity_type stringifies a missing resource_id to the literal "undefined"
    // and would query `WHERE slug = 'undefined'`; the up-front presence guard
    // must reject it handler-side instead of reaching the DB (ECONNREFUSED here).
    let caught: unknown;
    try {
      await manageViewTemplates(
        { action: "get", resource_type: "entity_type" } as never,
        undefined,
        ctx,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const message = (caught as Error).message;
    expect(message).toMatch(/resource_id/);
    // Proves the guard fired before the (non-connecting) DB client was used.
    expect(message).not.toMatch(/ECONNREFUSED/);
    expect(message).not.toMatch(/connect/i);
  });

  it("accepts a well-shaped get and passes the guard through to the DB layer", async () => {
    // A valid shape must NOT be rejected by the guard. With no reachable DB the
    // call fails at the connection layer, which proves validation passed: the
    // error is a DB/connection error, NOT our ToolUserError validation error.
    let caught: unknown;
    try {
      await manageViewTemplates(
        { action: "get", resource_type: "entity", resource_id: 42 } as never,
        undefined,
        ctx,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(ToolUserError);
    const message = (caught as Error).message;
    // Whatever the DB-layer failure is, it must not be the old NaN bigint error
    // (that would mean a bad value reached the query unguarded).
    expect(message).not.toMatch(/invalid input syntax for type bigint: "NaN"/);
  });
});

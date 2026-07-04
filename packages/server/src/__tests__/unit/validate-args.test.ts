import { describe, expect, it } from "bun:test";
import { Type } from "@sinclair/typebox";
import { getAllTools, getTool } from "../../tools/registry";
import { validateToolArgs, validateToolResult, withValidatedArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";

describe("validateToolArgs coercion", () => {
  const schema = Type.Object({
    id: Type.Number(),
    name: Type.String(),
    limit: Type.Optional(Type.Number({ default: 50 })),
  });

  it("coerces a numeric string to number and a number to string", () => {
    const out = validateToolArgs("t", schema, { id: "42", name: 7 }) as Record<string, unknown>;
    expect(out.id).toBe(42);
    expect(out.name).toBe("7");
  });

  it("does NOT materialize schema defaults — handlers own defaulting", () => {
    // read_knowledge declares `sort_by: { default: 'score' }` while its
    // include_superseded path requires sort_by to be UNSET; injecting schema
    // defaults at the boundary broke it. `default:` stays client-facing docs.
    const out = validateToolArgs("t", schema, { id: 1, name: "a" }) as Record<string, unknown>;
    expect("limit" in out).toBe(false);
  });

  it("rejects a missing required field, naming it once", () => {
    let caught: unknown;
    try {
      validateToolArgs("t", schema, { id: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const msg = (caught as ToolUserError).message;
    expect(msg).toMatch(/name/);
    expect(msg.match(/\/name/g)?.length).toBe(1);
  });

  it("rejects an uncoercible value", () => {
    expect(() => validateToolArgs("t", schema, { id: "abc", name: "x" })).toThrow(ToolUserError);
  });

  it("passes explicitly-undefined optional keys (REST query-param pattern)", () => {
    const out = validateToolArgs("t", schema, {
      id: 1,
      name: "a",
      limit: undefined,
    }) as Record<string, unknown>;
    expect(out.id).toBe(1);
  });

  it("passes an explicitly-undefined Optional(Array) key (Convert would wrap it as [undefined])", () => {
    const arrSchema = Type.Object({
      name: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
    });
    const out = validateToolArgs("t", arrSchema, {
      name: "x",
      tags: undefined,
    }) as Record<string, unknown>;
    expect(out.tags).toBeUndefined();
  });

  it("rejects null for an optional non-nullable field", () => {
    const optSchema = Type.Object({ note: Type.Optional(Type.String()) });
    expect(() => validateToolArgs("t", optSchema, { note: null })).toThrow(ToolUserError);
  });

  it("rejects unknown properties only under additionalProperties:false", () => {
    const strict = Type.Object({ a: Type.String() }, { additionalProperties: false });
    const open = Type.Object({ a: Type.String() });
    expect(() => validateToolArgs("t", strict, { a: "x", extra: 1 })).toThrow(ToolUserError);
    const out = validateToolArgs("t", open, { a: "x", extra: 1 }) as Record<string, unknown>;
    expect(out.extra).toBe(1);
  });

  it("accepts a valid uuid format and rejects a bad one", () => {
    const s = Type.Object({ id: Type.String({ format: "uuid" }) });
    const ok = validateToolArgs("t", s, {
      id: "f6a7b2c1-3d4e-4f50-8a9b-0c1d2e3f4a5b",
    }) as Record<string, unknown>;
    expect(ok.id).toBe("f6a7b2c1-3d4e-4f50-8a9b-0c1d2e3f4a5b");
    expect(() => validateToolArgs("t", s, { id: "not-a-uuid" })).toThrow(ToolUserError);
  });
});

describe("validateToolArgs union variant dispatch", () => {
  const union = Type.Union([
    Type.Object({ action: Type.Literal("create"), name: Type.String() }),
    Type.Object({ action: Type.Literal("delete"), id: Type.Number() }),
  ]);

  it("validates against the matched variant only", () => {
    const out = validateToolArgs("t", union, { action: "delete", id: "5" }) as Record<
      string,
      unknown
    >;
    expect(out.id).toBe(5);
  });

  it("tolerates fields from other variants (flattened advertised schema)", () => {
    const out = validateToolArgs("t", union, {
      action: "create",
      name: "x",
      id: 99,
    }) as Record<string, unknown>;
    expect(out.name).toBe("x");
  });

  it("reports the variant's missing field, not a union blob", () => {
    let caught: unknown;
    try {
      validateToolArgs("t", union, { action: "create" });
    } catch (err) {
      caught = err;
    }
    expect((caught as ToolUserError).message).toMatch(/name/);
  });

  it("rejects an unknown action listing the valid ones", () => {
    let caught: unknown;
    try {
      validateToolArgs("t", union, { action: "explode" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    expect((caught as ToolUserError).message).toMatch(/create, delete/);
  });

  it("rejects a missing action the same way", () => {
    expect(() => validateToolArgs("t", union, {})).toThrow(ToolUserError);
  });
});

describe("withValidatedArgs", () => {
  it("passes the coerced args to the handler and forwards the rest", async () => {
    const schema = Type.Object({ id: Type.Number() });
    const fn = withValidatedArgs(
      "t",
      schema,
      async (args: { id: number }, extra: string) => `${args.id}:${typeof args.id}:${extra}`
    );
    await expect(fn({ id: "9" } as never, "env")).resolves.toBe("9:number:env");
  });
});

describe("registry completeness", () => {
  // `withValidatedArgs` stamps the wrapped handler with this globally-registered
  // brand symbol carrying the tool name it was wrapped for.
  const VALIDATED_BRAND = Symbol.for("lobu.validated-tool-handler");
  const brandedName = (handler: unknown): string | undefined =>
    (handler as Record<symbol, string | undefined>)?.[VALIDATED_BRAND];

  it("every registered tool handler is wrapped with withValidatedArgs", () => {
    // `list_organizations` is a throw-stub in the registry: executeTool
    // special-cases it and calls the (wrapped) listOrganizations directly.
    const exempt = new Set(["list_organizations"]);
    const unwrapped = getAllTools()
      .map((t) => t.name)
      .filter((name) => !exempt.has(name))
      .filter((name) => brandedName(getTool(name)?.handler) !== name);
    expect(unwrapped).toEqual([]);
  });
});

describe("validateToolResult (structuredContent emission)", () => {
  const schema = Type.Object({
    created_at: Type.String(),
    count: Type.Integer(),
    text: Type.String(),
  });

  it("coerces a Date to an ISO string so a raw SQL row satisfies Type.String()", () => {
    const when = new Date("2026-07-04T00:00:00.000Z");
    const out = validateToolResult(schema, { created_at: when, count: 3, text: "hi" }) as Record<
      string,
      unknown
    >;
    expect(out).not.toBeNull();
    expect(out.created_at).toBe("2026-07-04T00:00:00.000Z");
  });

  it("returns null (→ text-only fallback) when the result cannot satisfy the schema", () => {
    // text_content NULL where the schema demands a non-null string — the exact
    // drift that used to reach the client as a validation error. Now: no
    // structuredContent, not a failed call.
    expect(validateToolResult(schema, { created_at: "x", count: 1, text: null })).toBeNull();
  });

  it("accepts any variant of a discriminated result union", () => {
    const union = Type.Union([
      Type.Object({ status: Type.Literal("completed"), output: Type.Unknown() }),
      Type.Object({ status: Type.Literal("failed"), error_message: Type.String() }),
    ]);
    // A non-object `output` (array) must still validate — manage_operations #9.
    expect(validateToolResult(union, { status: "completed", output: [1, 2] })).not.toBeNull();
    expect(validateToolResult(union, { status: "failed", error_message: "boom" })).not.toBeNull();
  });
});

describe("registry outputSchema normalization (MCP spec: must be an object schema)", () => {
  it("stamps type:'object' on union result schemas while keeping the anyOf variants", () => {
    // The 8 admin tools declare Type.Union result schemas → bare `{ anyOf }`.
    // A spec-strict host rejects an outputSchema without top-level type:object.
    const byName = new Map(getAllTools().map((t) => [t.name, t]));
    const watchers = byName.get("manage_watchers") as { outputSchema?: any } | undefined;
    expect(watchers?.outputSchema?.type).toBe("object");
    expect(Array.isArray(watchers?.outputSchema?.anyOf)).toBe(true);
  });

  it("leaves an already-object result schema (search_memory) untouched", () => {
    const byName = new Map(getAllTools().map((t) => [t.name, t]));
    const search = byName.get("search_memory") as { outputSchema?: any } | undefined;
    expect(search?.outputSchema?.type).toBe("object");
  });
});

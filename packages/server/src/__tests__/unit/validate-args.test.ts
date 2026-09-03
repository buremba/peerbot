import { describe, expect, it } from "bun:test";
import { ManageOperationsSchema } from "@lobu/core/contracts/tools/manage-operations";
import { Type } from "@sinclair/typebox";
import { getAllTools, getMcpTools, getTool } from "../../tools/registry";
import {
  markAcceptedInternalFields,
  validateToolArgs,
  validateToolResult,
  withValidatedArgs,
} from "../../tools/validate-args";
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

  it("rejects unknown top-level keys, naming them and the valid set", () => {
    // TypeBox Type.Object accepts extra keys, so an unknown argument used to
    // be silently dropped — the call "succeeded" while ignoring the caller's
    // intent (e.g. agent_id passed to an action that lacked it).
    const strict = Type.Object({ a: Type.String() }, { additionalProperties: false });
    const open = Type.Object({ a: Type.String() });
    expect(() => validateToolArgs("t", strict, { a: "x", extra: 1 })).toThrow(ToolUserError);
    let caught: unknown;
    try {
      validateToolArgs("t", open, { a: "x", extra: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const msg = (caught as ToolUserError).message;
    expect(msg).toMatch(/unknown argument\(s\): extra/);
    expect(msg).toMatch(/valid arguments are: a/);
  });

  it("rejects Object.prototype-named keys (constructor, toString) — no prototype-chain false accept", () => {
    // `key in properties` would walk Object.prototype and wrongly accept these
    // as "known" keys; Object.hasOwn does not.
    const s = Type.Object({ a: Type.String() });
    for (const bad of ["constructor", "toString", "hasOwnProperty"]) {
      let caught: unknown;
      try {
        validateToolArgs("t", s, { a: "x", [bad]: 1 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ToolUserError);
      expect((caught as ToolUserError).message).toMatch(
        new RegExp(`unknown argument\\(s\\): ${bad}`)
      );
    }
  });

  it("rejects a JSON __proto__ key as unknown and does not pollute the prototype", () => {
    // JSON.parse produces `__proto__` as an OWN enumerable property (unlike a
    // JS object literal, which sets the prototype). normalizeArgs must copy it
    // as a real own key (via defineProperty), not through `obj[k] =` which
    // would invoke the __proto__ setter and mutate the prototype — hiding it
    // from Object.keys so rejectUnknownKeys can't reject it.
    const s = Type.Object({ a: Type.String() });
    const payload = JSON.parse('{"a":"x","__proto__":{"polluted":"yes"}}');
    let caught: unknown;
    try {
      validateToolArgs("t", s, payload);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    expect((caught as ToolUserError).message).toMatch(/unknown argument\(s\): __proto__/);
    // No prototype pollution occurred.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("still passes extra keys through passthrough schemas (additionalProperties / Record)", () => {
    const passthrough = Type.Object({ a: Type.String() }, { additionalProperties: true });
    const out = validateToolArgs("t", passthrough, { a: "x", extra: 1 }) as Record<string, unknown>;
    expect(out.extra).toBe(1);
    const record = Type.Record(Type.String(), Type.Number());
    const rec = validateToolArgs("t", record, { anything: 2 }) as Record<string, unknown>;
    expect(rec.anything).toBe(2);
  });

  it("accepts a valid uuid format and rejects a bad one", () => {
    const s = Type.Object({ id: Type.String({ format: "uuid" }) });
    const ok = validateToolArgs("t", s, {
      id: "f6a7b2c1-3d4e-4f50-8a9b-0c1d2e3f4a5b",
    }) as Record<string, unknown>;
    expect(ok.id).toBe("f6a7b2c1-3d4e-4f50-8a9b-0c1d2e3f4a5b");
    expect(() => validateToolArgs("t", s, { id: "not-a-uuid" })).toThrow(ToolUserError);
  });

  it("accepts the URI format used by page-activated operation URLs", () => {
    const out = validateToolArgs("manage_operations", ManageOperationsSchema, {
      action: "execute",
      connection_id: 399,
      operation_key: "prepare_reply",
      activation: {
        kind: "page_visit",
        urls: ["https://x.com/dhh/status/2087839779811373514"],
      },
    }) as Record<string, unknown>;

    expect(out.activation).toEqual({
      kind: "page_visit",
      urls: ["https://x.com/dhh/status/2087839779811373514"],
    });
    expect(() =>
      validateToolArgs("manage_operations", ManageOperationsSchema, {
        action: "execute",
        connection_id: 399,
        operation_key: "prepare_reply",
        activation: { kind: "page_visit", urls: ["https://example.com/a b"] },
      })
    ).toThrow(ToolUserError);
  });
});

describe("validateToolArgs error humanization", () => {
  it("enumerates allowed literals for a union-of-literals field (not 'Expected union value')", () => {
    // list_scope: Type.Union([Type.Literal('accessible'), Type.Literal('organization')]).
    // TypeBox emits the bare "Expected union value" with no literals — useless for
    // autonomous recovery. The message must name the valid values.
    const schema = Type.Object({
      list_scope: Type.Union([Type.Literal("accessible"), Type.Literal("organization")]),
    });
    let caught: unknown;
    try {
      validateToolArgs("t", schema, { list_scope: "org" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const msg = (caught as ToolUserError).message;
    expect(msg).not.toMatch(/Expected union value/);
    expect(msg).toMatch(/accessible/);
    expect(msg).toMatch(/organization/);
  });

  it("enumerates allowed literals for a bare enum field", () => {
    const schema = Type.Object({
      kind: Type.Union([Type.Literal("connectors"), Type.Literal("agents")]),
    });
    let caught: unknown;
    try {
      validateToolArgs("t", schema, { kind: "bogus" });
    } catch (err) {
      caught = err;
    }
    const msg = (caught as ToolUserError).message;
    expect(msg).toMatch(/connectors/);
    expect(msg).toMatch(/agents/);
  });

  it("enumerates allowed literals for a bad ELEMENT of an array-of-literals field", () => {
    // catalog.listCatalog({ kinds: ['connector'] }) live-failed with the bare
    // "Expected union value": the error path is `/kinds/0`, and subschemaAtPath
    // only walked `properties` — an array index must resolve to the array's
    // item schema so the allowed values get named.
    const schema = Type.Object({
      kinds: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("connectors"),
            Type.Literal("skills"),
            Type.Literal("automations"),
          ])
        )
      ),
    });
    let caught: unknown;
    try {
      validateToolArgs("t", schema, { kinds: ["connector"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const msg = (caught as ToolUserError).message;
    expect(msg).not.toMatch(/Expected union value/);
    expect(msg).toMatch(/connectors/);
    expect(msg).toMatch(/skills/);
    expect(msg).toMatch(/automations/);
  });

  it("reports a missing required field AND an unknown field together (not just the first)", () => {
    // { id: 1 } for a schema wanting { feed_id } used to report only the missing
    // feed_id, never that `id` is unknown — so the agent fixes one problem at a
    // time. Both must surface in one message.
    const schema = Type.Object({ feed_id: Type.Number() }, { additionalProperties: false });
    let caught: unknown;
    try {
      validateToolArgs("t", schema, { id: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const msg = (caught as ToolUserError).message;
    expect(msg).toMatch(/feed_id/); // missing required
    expect(msg).toMatch(/id/); // unknown supplied
    expect(msg).toMatch(/unknown/i);
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

  it("rejects a field from ANOTHER variant, naming the matched action's valid args", () => {
    // `id` belongs to the delete variant; passing it to create used to be
    // silently dropped. The unknown-key check runs against the MATCHED
    // variant's properties (post-dispatch), so the error names the action
    // and its actual argument set.
    let caught: unknown;
    try {
      validateToolArgs("t", union, { action: "create", name: "x", id: 99 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const msg = (caught as ToolUserError).message;
    expect(msg).toMatch(/unknown argument\(s\): id/);
    expect(msg).toMatch(/action 'create'/);
    expect(msg).toMatch(/name/);
  });

  it("accepts every declared arg of the matched variant, action key included (no flattened-union false positive)", () => {
    const out = validateToolArgs("t", union, { action: "delete", id: 7 }) as Record<
      string,
      unknown
    >;
    expect(out.action).toBe("delete");
    expect(out.id).toBe(7);
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
    const unwrapped = [...getAllTools(), ...getMcpTools()]
      .map((t) => t.name)
      .filter((name, index, names) => names.indexOf(name) === index)
      .filter((name) => !exempt.has(name))
      .filter((name) => brandedName(getTool(name)?.handler) !== name);
    expect(unwrapped).toEqual([]);
  });

  it("manage_automations accepts the consolidated list filters", () => {
    const schema = getTool("manage_automations")?.inputSchema;
    if (!schema) throw new Error("manage_automations is not registered");
    expect(
      validateToolArgs("manage_automations", schema, {
        action: "list",
        managed_agent_id: "agent-1",
        status: "active",
        include_details: true,
        order_by: "last_fired_at",
        order_dir: "asc",
        limit: 25,
      })
    ).toMatchObject({
      action: "list",
      status: "active",
      include_details: true,
      order_by: "last_fired_at",
      order_dir: "asc",
    });
    expect(() =>
      validateToolArgs("manage_automations", schema, {
        action: "list",
        status: "unknown",
      })
    ).toThrow(ToolUserError);
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
    const automations = byName.get("manage_automations") as { outputSchema?: any } | undefined;
    expect(automations?.outputSchema?.type).toBe("object");
    expect(Array.isArray(automations?.outputSchema?.anyOf)).toBe(true);
  });

  it("leaves an already-object result schema (search_memory) untouched", () => {
    const byName = new Map(getAllTools().map((t) => [t.name, t]));
    const search = byName.get("search_memory") as { outputSchema?: any } | undefined;
    expect(search?.outputSchema?.type).toBe("object");
  });
});

describe("accepted-but-unadvertised arg annotation", () => {
  const schema = Type.Object({
    query: Type.String(),
    limit: Type.Optional(Type.Number()),
    agent_id: Type.Optional(Type.String()),
  });
  markAcceptedInternalFields(schema, ["agent_id"]);

  it("omits annotated fields from the unknown-argument error's valid-args list", () => {
    let msg = "";
    try {
      validateToolArgs("t", schema, { query: "q", nope: 1 });
    } catch (err) {
      msg = (err as ToolUserError).message;
    }
    expect(msg).toContain("unknown argument(s): nope");
    // The whole point: an error message must not publish an arg the tool's
    // advertised schema deliberately hides.
    expect(msg).not.toContain("agent_id");
    // …while still naming the genuinely public ones.
    expect(msg).toContain("query");
    expect(msg).toContain("limit");
  });

  it("still ACCEPTS the annotated field — it is hidden, not rejected", () => {
    const out = validateToolArgs("t", schema, { query: "q", agent_id: "a1" }) as Record<
      string,
      unknown
    >;
    expect(out.agent_id).toBe("a1");
  });

  it("keeps search_memory's server-internal args out of the ADVERTISED inputSchema", () => {
    // The published schema is what an agent reads to learn the tool's surface.
    // `agent_id` and `query_embedding` stay accepted by the handler but must
    // not be advertised — and the marker that hides them from error text must
    // not sneak into the advertised payload either.
    const byName = new Map(getAllTools().map((t) => [t.name, t]));
    const search = byName.get("search_memory") as { inputSchema?: any } | undefined;
    const props = Object.keys(search?.inputSchema?.properties ?? {});
    expect(props).not.toContain("agent_id");
    expect(props).not.toContain("query_embedding");
    // The public knobs are still there.
    expect(props).toContain("query");
    expect(props).toContain("min_similarity");
    expect(JSON.stringify(search?.inputSchema)).not.toContain(
      "x-lobu-accepted-internal-fields"
    );
  });

  it("does not serialize the marker into JSON.stringify(schema)", () => {
    // A TypeBox schema is routinely stringified into tools/list payloads and
    // discovery metadata. An ENUMERABLE marker would ship the hidden field
    // names straight to clients — publishing exactly what the annotation
    // exists to suppress. Non-enumerable is what makes the marker inert for a
    // future tool that opts in WITHOUT declaring a separate publicInputSchema.
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("x-lobu-accepted-internal-fields");
    expect(Object.keys(schema)).not.toContain("x-lobu-accepted-internal-fields");
    // Spread/clone paths must drop it too, for the same reason.
    expect(JSON.stringify({ ...schema })).not.toContain("x-lobu-accepted-internal-fields");
  });
});

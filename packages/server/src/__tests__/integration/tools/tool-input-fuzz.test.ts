/**
 * Schema-driven property/fuzz guard for the ENTIRE MCP tool surface.
 *
 * Invariant: no tool may surface an UNHANDLED ENGINE error (Postgres
 * syntax/encoding error, raw 500) on adversarial input. A tool may reject input
 * gracefully (ToolUserError) or succeed or throw a typed app error — but a
 * leaked engine error is a bug (e.g. a leading newline → tsquery 400, or a NUL
 * byte → "invalid byte sequence for encoding UTF8: 0x00").
 *
 * This is the SELF-COVERING version: it enumerates `getAllTools()`, reads each
 * tool's JSON schema, and injects a shared nasty-input corpus into every string
 * field AND every open record field (keys + values). New tools and new params
 * are covered automatically — no per-tool spec to maintain. A handful of tools
 * that don't take fuzzable input or execute code are skipped (SKIP set, below).
 *
 * Harness: vitest + embedded Postgres; handlers are called directly.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { getAllTools, getTool, type ToolContext } from '../../../tools/registry';
import { ToolUserError } from '../../../utils/errors';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const NUL = String.fromCharCode(0);

// Schema-valid but adversarial strings (all pass `type: string`, so they reach
// handler/SQL logic instead of bouncing off validation).
const NASTY = [
  `\nleading newline`,
  `\tleading tab`,
  `a\n\nb\nc`,
  `\n\t  \r\n`,
  `foo & bar | baz ! qux : * ( )`,
  `| leading pipe`,
  `(unclosed`,
  `pre*fix:*`,
  `🎉 日本語 café`,
  `O'Brien "quote"`,
  `'; DROP TABLE events; --`,
  `100%_x_\\`,
  `!@#$%^&*()`,
  `the and of to is`,
  ``,
  `x `.repeat(3000),
  `a${NUL}b`, // NUL byte
];

// Tools that don't take fuzzable text input, or execute code/SDK (out of scope
// for input-SQL robustness, and may have side effects / need a sandbox).
const SKIP = new Set([
  'list_organizations', // no input
  'run_sdk', // executes arbitrary TS in an isolate
  'query_sdk', // executes SDK script
  'search_sdk', // executes SDK script
]);

/** postgres.js engine errors carry severity/routine and a SQLSTATE code. */
function isLeakedEngineError(err: unknown): boolean {
  if (err instanceof ToolUserError) return false;
  const e = err as { severity?: unknown; routine?: unknown; code?: unknown; message?: unknown };
  if (e?.severity !== undefined || e?.routine !== undefined) return true;
  if (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return true;
  return /invalid byte sequence|syntax error in tsquery|encoding "UTF8"|tsquery|tsvector/i.test(
    String(e?.message ?? '')
  );
}

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  additionalProperties?: SchemaNode | boolean;
  anyOf?: SchemaNode[];
  const?: unknown;
  enum?: unknown[];
}

/** A minimal schema-valid value for a node, used to fill required fields. */
function baselineValue(node: SchemaNode): unknown {
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
  switch (node.type) {
    case 'string':
      return 'x';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'x';
  }
}

/** Resolve a (possibly union) schema to a concrete object node + a baseline. */
function resolveObject(schema: SchemaNode): { node: SchemaNode; baseline: Record<string, unknown> } {
  const node = schema.anyOf?.length ? schema.anyOf[0] : schema;
  const baseline: Record<string, unknown> = {};
  for (const key of node.required ?? []) {
    const prop = node.properties?.[key];
    if (prop) baseline[key] = baselineValue(prop);
  }
  return { node, baseline };
}

describe('MCP tool surface > schema-driven input fuzz: no tool leaks an engine error', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let entityId: number;
  const env = { ENVIRONMENT: 'test' } as Env;

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: 'fuzz-user',
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Schema Fuzz Org' });
    const user = await createTestUser({ email: 'schema-fuzz@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    entityId = (await createTestEntity({ name: 'Fuzz Entity', organization_id: org.id })).id;
  });

  it('fuzzes every tool string + record field with the nasty corpus', async () => {
    // getAllTools() returns metadata WITHOUT handlers; getTool() returns the full
    // definition (raw schema + handler). Resolve to real handlers so we actually
    // execute the tools — and assert each is callable so this can never silently
    // pass without running anything (the false-green the review caught).
    const tools = getAllTools()
      .filter((t) => !SKIP.has(t.name))
      .map((t) => getTool(t.name))
      .filter((d): d is NonNullable<typeof d> => !!d);
    expect(tools.length).toBeGreaterThan(5);
    for (const t of tools) expect(typeof t.handler).toBe('function');

    const leaks: Array<{ tool: string; field: string; sample: string; error: string }> = [];
    // A tool only counts as actually fuzzed if at least one call got PAST arg
    // validation into the handler. A union/action tool whose baseline can't be
    // synthesized is rejected by validateToolArgs ("Invalid arguments for …") and
    // never exercises its SQL — tracking this prevents a silent false-green.
    const reachedHandler = new Set<string>();
    let calls = 0;

    const isValidationReject = (err: unknown): boolean =>
      err instanceof ToolUserError && /^Invalid arguments for /.test(err.message);

    for (const tool of tools) {
      const { node, baseline } = resolveObject(tool.inputSchema as SchemaNode);
      const props = node.properties ?? {};
      // Give id-shaped fields a real entity so we exercise the query, not a 404.
      for (const key of Object.keys(props)) {
        if (/entity_ids/.test(key)) baseline[key] = [entityId];
        else if (/entity_id$/.test(key)) baseline[key] = entityId;
      }

      const run = async (field: string, args: Record<string, unknown>, sample: string) => {
        calls++;
        try {
          await (tool.handler as (a: unknown, e: Env, c: ToolContext) => Promise<unknown>)(
            args,
            env,
            ctx()
          );
          reachedHandler.add(tool.name); // succeeded → handler ran
        } catch (err) {
          if (!isValidationReject(err)) reachedHandler.add(tool.name); // threw past validation
          if (isLeakedEngineError(err)) {
            leaks.push({ tool: tool.name, field, sample: JSON.stringify(sample).slice(0, 40), error: String(err).slice(0, 120) });
          }
          // typed app errors / ToolUserError → acceptable
        }
      };

      for (const [field, prop] of Object.entries(props)) {
        if (prop.type === 'string') {
          for (const nasty of NASTY) await run(field, { ...baseline, [field]: nasty }, nasty);
        } else if (
          prop.type === 'object' &&
          (prop.additionalProperties === true || typeof prop.additionalProperties === 'object') &&
          !prop.properties
        ) {
          // Open record (e.g. metadata): fuzz both KEY and VALUE.
          for (const nasty of [`a${NUL}b`, `\nk`, `weird key`]) {
            await run(field, { ...baseline, [field]: { [nasty]: nasty } }, `{${nasty}}`);
          }
        }
      }
    }

    if (leaks.length > 0) {
      throw new Error(
        `${leaks.length} tool/field combinations leaked an engine error (of ${calls} calls):\n` +
          leaks.slice(0, 12).map((l) => `  ${l.tool}.${l.field} [${l.sample}] -> ${l.error}`).join('\n')
      );
    }

    // The fuzz is only meaningful if calls actually reached handlers. Require the
    // high-risk SQL/text tools to be genuinely exercised (not just rejected at
    // validation) — this is what makes a false-green impossible.
    expect(calls).toBeGreaterThan(50);
    for (const must of ['search_memory', 'save_memory', 'resolve_path']) {
      expect(reachedHandler.has(must), `${must} must reach its handler`).toBe(true);
    }
    // Surface which tools the generator could NOT drive into their handler
    // (e.g. action-union tools whose baseline validation rejects) — visible, not
    // a silent gap. These are a known coverage limit, not a pass-by-omission.
    const notReached = tools.map((t) => t.name).filter((n) => !reachedHandler.has(n));
    if (notReached.length) {
      console.warn(`[tool-fuzz] not exercised (baseline rejected at validation): ${notReached.join(', ')}`);
    }
  });
});

import { describe, expect, it } from 'bun:test';
import { REDACTED_SENTINEL } from '@lobu/core';
import { Type } from '@sinclair/typebox';
import { sanitizeAuditArgs } from '../../tools/audit-args';

/**
 * Mirrors a real `manage_*` tool: `defineActionTool` derives `Type.Union` of
 * per-action variants, each carrying an `action` literal. Built with TypeBox
 * rather than hand-written JSON so the test also pins the serialized shape the
 * sanitizer reads (`anyOf` + `const`).
 */
const ACTION_TOOL_SCHEMA = Type.Union([
  Type.Object({
    action: Type.Literal('list_available'),
    connection_id: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal('execute'),
    operation_key: Type.String(),
    input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    dry_run: Type.Optional(Type.Boolean()),
  }),
]);

describe('sanitizeAuditArgs', () => {
  it('retains a declared literal discriminator', () => {
    expect(
      sanitizeAuditArgs({ action: 'list_available', limit: 25 }, ACTION_TOOL_SCHEMA)
    ).toEqual({ action: 'list_available', limit: REDACTED_SENTINEL });
  });

  it('retains the literal from any variant of the union', () => {
    expect(
      sanitizeAuditArgs({ action: 'execute', operation_key: 'navigate' }, ACTION_TOOL_SCHEMA)
    ).toEqual({ action: 'execute', operation_key: REDACTED_SENTINEL });
  });

  it('sentinels a declared key whose value is not a declared literal', () => {
    // Audit fires on FAILED validation too: `action` can arrive carrying
    // arbitrary pasted text, which must never survive.
    expect(sanitizeAuditArgs({ action: 'sk-live-abcdef123456' }, ACTION_TOOL_SCHEMA)).toEqual({
      action: REDACTED_SENTINEL,
    });
  });

  it('sentinels the NAME of a key the schema does not declare', () => {
    expect(sanitizeAuditArgs({ authorization: 'Bearer abc' }, ACTION_TOOL_SCHEMA)).toEqual({
      [REDACTED_SENTINEL]: REDACTED_SENTINEL,
    });
  });

  it('keeps booleans and null, which are structural', () => {
    expect(
      sanitizeAuditArgs(
        { action: 'execute', dry_run: true, input: null },
        ACTION_TOOL_SCHEMA
      )
    ).toEqual({ action: 'execute', dry_run: true, input: null });
  });

  it('never retains a literal below the top level', () => {
    // A nested object is caller-shaped even when a leaf happens to equal a
    // declared constant, so both its keys and its values collapse.
    expect(
      sanitizeAuditArgs(
        { action: 'execute', input: { action: 'execute', url: 'https://x.test' } },
        ACTION_TOOL_SCHEMA
      )
    ).toEqual({
      action: 'execute',
      input: { [REDACTED_SENTINEL]: REDACTED_SENTINEL },
    });
  });

  it('collapses a key to name-only when one union branch is open', () => {
    const schema = Type.Object({
      mode: Type.Union([Type.Literal('fast'), Type.String()]),
      kind: Type.Union([Type.Literal('a'), Type.Literal('b')]),
    });
    expect(sanitizeAuditArgs({ mode: 'fast', kind: 'b' }, schema)).toEqual({
      mode: REDACTED_SENTINEL,
      kind: 'b',
    });
  });

  it('honors a flat enum declaration', () => {
    const schema = Type.Object({
      action: Type.Unsafe<string>({ type: 'string', enum: ['list', 'get'] }),
    });
    expect(sanitizeAuditArgs({ action: 'list' }, schema)).toEqual({ action: 'list' });
    expect(sanitizeAuditArgs({ action: 'drop table' }, schema)).toEqual({
      action: REDACTED_SENTINEL,
    });
  });

  it('sentinels every leaf when the tool has no schema', () => {
    expect(sanitizeAuditArgs({ action: 'list_available' }, undefined)).toEqual({
      [REDACTED_SENTINEL]: REDACTED_SENTINEL,
    });
  });

  it('treats absent args as an empty call', () => {
    // Reachable: the REST tool proxy passes `await c.req.json()` straight
    // through, so a `null` body arrives here despite the declared type.
    expect(sanitizeAuditArgs(null, ACTION_TOOL_SCHEMA)).toEqual({});
    expect(sanitizeAuditArgs(undefined, ACTION_TOOL_SCHEMA)).toEqual({});
  });

  it('sanitizes array items without retaining their contents', () => {
    const schema = Type.Object({ ids: Type.Array(Type.Number()) });
    expect(sanitizeAuditArgs({ ids: [1, 2] }, schema)).toEqual({
      ids: [REDACTED_SENTINEL, REDACTED_SENTINEL],
    });
  });
});

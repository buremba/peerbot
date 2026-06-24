/**
 * Integration: extractReactionInputSchema reads a reaction's exported `input`
 * (a TypeBox schema = JSON Schema) by loading the compiled module in the isolate
 * WITHOUT invoking the handler. This is how a reaction watcher's extraction
 * contract is derived so the worker is told the shape its reaction Value.Parses.
 *
 * Compiles real TS in the isolate runner (no DB needed).
 */

import { describe, expect, it } from 'vitest';
import { extractReactionInputSchema } from '../../../watchers/reaction-executor';

const REACTION_WITH_INPUT = `
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ReactionContext, ReactionClient } from "@lobu/connector-sdk";

export const input = Type.Object({
  outcome: Type.Union([Type.Literal("placed"), Type.Literal("manual")]),
  restaurant: Type.Optional(Type.String()),
});

export default async function (ctx: ReactionContext, client: ReactionClient) {
  const data = Value.Parse(input, ctx.extracted_data);
  return { ok: data.outcome };
}
`;

const REACTION_NO_INPUT = `
export default async function (ctx: any, client: any) {
  return { ok: true };
}
`;

describe('extractReactionInputSchema', () => {
  it('extracts the exported input as JSON Schema (TypeBox symbols dropped)', async () => {
    const schema = await extractReactionInputSchema(REACTION_WITH_INPUT);
    expect(schema).not.toBeNull();
    expect(schema?.type).toBe('object');
    const props = schema?.properties as Record<string, unknown> | undefined;
    expect(props).toBeTruthy();
    expect(props).toHaveProperty('outcome');
    expect(props).toHaveProperty('restaurant');
    // round-trips as plain JSON (no Symbol-keyed TypeBox internals leak)
    expect(() => JSON.stringify(schema)).not.toThrow();
    expect(JSON.stringify(schema)).toContain('"required"');
  });

  it('returns null when the reaction declares no input export (free-form fallback)', async () => {
    expect(await extractReactionInputSchema(REACTION_NO_INPUT)).toBeNull();
  });
});

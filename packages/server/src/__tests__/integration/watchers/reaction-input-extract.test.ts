/**
 * Integration: extractReactionInputSchema reads a reaction's exported `input`
 * (a PLAIN JSON Schema object) by loading the compiled module in the isolate
 * WITHOUT invoking the handler. This is how a reaction watcher's extraction
 * contract is derived so the worker is told the shape the host validates
 * extracted_data against. Reactions declare `input` as plain JSON Schema (no
 * typebox — it breaks the isolate client; see reaction-execute-typebox.test.ts).
 *
 * Compiles real TS in the isolate runner (no DB needed).
 */

import { describe, expect, it } from 'vitest';
import { extractReactionInputSchema } from '../../../watchers/reaction-executor';

const REACTION_WITH_INPUT = `
import type { ReactionContext, ReactionClient } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    outcome: { enum: ["placed", "manual"] },
    restaurant: { type: "string" },
  },
  required: ["outcome"],
};

interface Input { outcome: "placed" | "manual"; restaurant?: string; }

export default async function (ctx: ReactionContext, client: ReactionClient) {
  const data = ctx.extracted_data as Input;
  return { ok: data.outcome };
}
`;

const REACTION_NO_INPUT = `
export default async function (ctx: any, client: any) {
  return { ok: true };
}
`;

describe('extractReactionInputSchema', () => {
  it('extracts the exported plain JSON Schema input', async () => {
    const schema = await extractReactionInputSchema(REACTION_WITH_INPUT);
    expect(schema).not.toBeNull();
    expect(schema?.type).toBe('object');
    const props = schema?.properties as Record<string, unknown> | undefined;
    expect(props).toBeTruthy();
    expect(props).toHaveProperty('outcome');
    expect(props).toHaveProperty('restaurant');
    expect(() => JSON.stringify(schema)).not.toThrow();
    expect(JSON.stringify(schema)).toContain('"required"');
  });

  it('returns null when the reaction declares no input export (free-form fallback)', async () => {
    expect(await extractReactionInputSchema(REACTION_NO_INPUT)).toBeNull();
  });
});

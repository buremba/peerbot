/**
 * Integration: a reaction must be able to reach the SDK client
 * (client.knowledge.save). Importing @sinclair/typebox into the reaction breaks
 * the isolate's client proxy (an esbuild/isolated-vm interaction — even `Type`
 * alone), so reactions declare `input` as a PLAIN JSON Schema object and the
 * HOST validates extracted_data; the reaction never imports typebox.
 *
 * Pins both: the plain-schema reaction works; the typebox reaction does NOT
 * reach the client (guards against re-introducing the typebox import).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  compileReactionScript,
  executeReaction,
} from '../../../watchers/reaction-executor';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const CTX = (orgId: string, data: Record<string, unknown>) => ({
  extracted_data: data,
  entities: [],
  window: {
    id: 1,
    watcher_id: 1,
    window_start: new Date('2026-01-01').toISOString(),
    window_end: new Date('2026-01-02').toISOString(),
    granularity: 'day',
    content_analyzed: 1,
  },
  watcher: { id: 1, slug: 'react-exec', name: 'React Exec', version: 1 },
  organization_id: orgId,
});

describe('executeReaction: plain-schema reactions reach the SDK client', () => {
  let orgId: string;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'React Exec Org' });
    orgId = org.id;
  });

  it('plain-JSON-Schema reaction reads extracted_data and calls client.knowledge.save', async () => {
    const compiled = await compileReactionScript(
      'export const input = { type: "object", properties: { s: { type: "string" } }, required: ["s"] };\n' +
        'export default async (ctx, client) => {\n' +
        '  const data = ctx.extracted_data;\n' +
        '  await client.knowledge.save({ content: data.s, semantic_type: "summary", metadata: {} });\n' +
        '};'
    );
    const res = await executeReaction({
      compiledScript: compiled,
      context: CTX(orgId, { s: 'PLAIN_OK' }) as never,
      env: process.env as Record<string, string | undefined>,
    });
    expect(res.error ?? null).toBeNull();
    expect(res.success).toBe(true);
  });

  it('GUARD: importing @sinclair/typebox breaks the client proxy (do not re-introduce)', async () => {
    const compiled = await compileReactionScript(
      'import { Type } from "@sinclair/typebox";\n' +
        'export const input = Type.Object({ s: Type.String() });\n' +
        'export default async (ctx, client) => { await client.knowledge.save({ content: "x", semantic_type: "summary", metadata: {} }); };'
    );
    const res = await executeReaction({
      compiledScript: compiled,
      context: CTX(orgId, { s: 'x' }) as never,
      env: process.env as Record<string, string | undefined>,
    });
    // Documents the constraint: the typebox bundle leaves client.knowledge undefined.
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/reading 'save'/);
  });
});

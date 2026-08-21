import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import type { Context } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../db/client';
import {
  ArtifactStore,
  eventArtifactBinding,
  runArtifactBinding,
} from '../../../gateway/files/artifact-store';
import type { Env } from '../../../index';
import * as lobuGateway from '../../../lobu/gateway';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { insertEvent } from '../../../utils/insert-event';
import { completeActionRun, streamContent } from '../../../worker-api';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

function mockWorkerCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = {
    body: undefined,
    status: 200,
  };
  const ctx = {
    req: { json: async () => body },
    var: {},
    json: (responseBody: unknown, status?: number) => {
      captured = { body: responseBody, status: status ?? 200 };
      return captured as unknown as Response;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

/**
 * Artifact directories are UUIDs; the store also keeps a `.trash` staging
 * directory alongside them for its rename-then-remove delete. Only the
 * artifacts are the subject of these assertions.
 */
async function readArtifactIds(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((entry) => !entry.startsWith('.')).sort();
}

describe('MCP media resources', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let artifactStore: ArtifactStore;
  let artifactsDir: string;
  const previousArtifactsDir = process.env.LOBU_ARTIFACTS_DIR;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeAll(async () => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'lobu-mcp-media-'));
    process.env.LOBU_ARTIFACTS_DIR = artifactsDir;
    process.env.ENCRYPTION_KEY = Buffer.from(
      '12345678901234567890123456789012',
    ).toString('base64');
    artifactStore = new ArtifactStore();

    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({
      name: 'MCP Media Org',
      slug: 'mcp-media-org',
    });
    owner = await createTestUser({
      email: 'mcp-media-owner@test.example.com',
    });
    await addUserToOrganization(owner.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    token = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'mcp:admin mcp:write mcp:read profile:read',
      })
    ).token;
    clearInMemoryMcpSessionsForTests();
  });

  afterAll(() => {
    if (previousArtifactsDir === undefined)
      delete process.env.LOBU_ARTIFACTS_DIR;
    else process.env.LOBU_ARTIFACTS_DIR = previousArtifactsDir;
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    if (artifactsDir) rmSync(artifactsDir, { recursive: true, force: true });
  });

  async function initSession(): Promise<string> {
    const path = `/mcp/${org.slug}`;
    const initResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__test_init__',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'lobu-mcp-media-test', version: '1.0' },
        },
      },
      token,
    });
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: {
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });
    return sessionId!;
  }

  it('materializes a direct save_memory image and returns a native resource link', async () => {
    const imageBytes = Buffer.from('direct-save-memory-image');
    const sessionId = await initSession();
    const path = `/mcp/${org.slug}`;
    const response = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'save-memory-media',
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            semantic_type: 'note',
            payload_type: 'media',
            title: 'Direct memory photo',
            idempotency_key: 'mcp-media-direct-save',
            attachments: [
              {
                kind: 'image',
                filename: 'direct-photo.png',
                mime_type: 'image/png',
                data: imageBytes.toString('base64'),
              },
            ],
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    const resource = body.result?.content?.find(
      (item: { type?: string }) => item.type === 'resource_link',
    );
    expect(resource).toEqual(
      expect.objectContaining({
        type: 'resource_link',
        uri: expect.stringMatching(/^lobu:\/\/event\/\d+\/attachment\/0$/),
        name: 'direct-photo.png',
        mimeType: 'image/png',
        size: imageBytes.length,
      }),
    );
    expect(body.result?.structuredContent?.attachments?.[0]).toEqual(
      expect.objectContaining({
        kind: 'image',
        filename: 'direct-photo.png',
        mime_type: 'image/png',
        artifact_id: expect.any(String),
        size_bytes: imageBytes.length,
      }),
    );
    expect(body.result?.structuredContent?.attachments?.[0]).not.toHaveProperty(
      'data',
    );

    const firstAttachment = body.result.structuredContent.attachments[0];
    const objectCount = (await readArtifactIds(artifactsDir)).length;
    const replayResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'save-memory-media-replay',
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            semantic_type: 'note',
            payload_type: 'media',
            title: 'Ignored replay photo',
            idempotency_key: 'mcp-media-direct-save',
            attachments: [
              {
                kind: 'image',
                filename: 'ignored.png',
                mime_type: 'image/png',
                data: Buffer.from('must-not-be-published').toString('base64'),
              },
            ],
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const replayBody = await replayResponse.json();
    expect(replayBody.result?.structuredContent?.created).toBe(false);
    expect(replayBody.result?.structuredContent?.attachments?.[0]).toEqual(
      firstAttachment,
    );
    expect((await readArtifactIds(artifactsDir)).length).toBe(objectCount);

    const readResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'read-direct-save-media',
        method: 'resources/read',
        params: { uri: resource.uri },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const readBody = await readResponse.json();
    expect(readBody.result?.contents?.[0]).toEqual({
      uri: resource.uri,
      mimeType: 'image/png',
      blob: imageBytes.toString('base64'),
    });
  });

  it('preserves both a failed save_memory insert and its cleanup failure', async () => {
    const sql = getDb();
    const baselineArtifacts = await readArtifactIds(artifactsDir);
    await sql.unsafe(`
      CREATE FUNCTION fail_media_save_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced media event insert failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_media_save_insert_trigger
        BEFORE INSERT ON events
        FOR EACH ROW
        WHEN (NEW.metadata->>'_lobu_idempotency_key' = 'mcp-media-cleanup-failure')
        EXECUTE FUNCTION fail_media_save_insert();
    `);
    const deleteSpy = vi
      .spyOn(ArtifactStore.prototype, 'delete')
      .mockRejectedValueOnce(new Error('forced retained-PVC cleanup failure'));

    let thrown: unknown;
    try {
      await saveContent(
        {
          semantic_type: 'note',
          payload_type: 'media',
          title: 'Must not persist',
          idempotency_key: 'mcp-media-cleanup-failure',
          attachments: [
            {
              kind: 'image',
              filename: 'uncommitted.png',
              mime_type: 'image/png',
              data: Buffer.from('uncommitted-image').toString('base64'),
            },
          ],
        } as never,
        {} as never,
        {
          organizationId: org.id,
          userId: owner.id,
          memberRole: 'owner',
          isAuthenticated: true,
          tokenType: 'oauth',
          scopedToOrg: false,
          allowCrossOrg: true,
          scopes: ['mcp:write'],
          sourceContext: null,
        } as ToolContext,
      );
    } catch (error) {
      thrown = error;
    } finally {
      deleteSpy.mockRestore();
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS fail_media_save_insert_trigger ON events;
        DROP FUNCTION IF EXISTS fail_media_save_insert();
      `);
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(
      (thrown as AggregateError).errors.map((error) => String(error)).join('\n'),
    ).toContain('forced media event insert failure');
    expect(
      (thrown as AggregateError).errors.map((error) => String(error)).join('\n'),
    ).toContain('forced retained-PVC cleanup failure');
    for (const candidateId of await readArtifactIds(artifactsDir)) {
      if (!baselineArtifacts.includes(candidateId)) {
        await artifactStore.delete(candidateId);
      }
    }
    expect(await readArtifactIds(artifactsDir)).toEqual(baselineArtifacts);
  });

  it('materializes streamed media with connection-over-feed binding and reads its resource', async () => {
    const imageBytes = Buffer.from('durable-event-image');
    const occurredAt = new Date().toISOString();
    const sql = getDb();
    const [connection] = await sql`
      INSERT INTO connections (
        organization_id, connector_key, status, visibility, slug, created_at, updated_at
      ) VALUES (
        ${org.id}, 'rss', 'active', 'org', 'mcp-media-stream', NOW(), NOW()
      )
      RETURNING id
    `;
    const connectionId = Number(connection!.id);
    const [feed] = await sql`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, status, created_at, updated_at
      ) VALUES (
        ${org.id}, ${connectionId}, 'items', 'active', NOW(), NOW()
      )
      RETURNING id
    `;
    const feedId = Number(feed!.id);
    const [run] = await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id, connector_key,
        connector_version, status, claimed_by, created_at
      ) VALUES (
        ${org.id}, 'sync', ${feedId}, ${connectionId}, 'rss', '1.0.0',
        'running', 'worker-mcp-media', NOW()
      )
      RETURNING id
    `;
    const runId = Number(run!.id);
    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: 'worker-mcp-media',
      items: [
        {
          id: 'mcp-media-event',
          title: 'Memory photo',
          payload_text: 'A streamed photo',
          payload_type: 'media',
          occurred_at: occurredAt,
          attachments: [
            {
              kind: 'image',
              filename: 'memory-photo.webp',
              mime_type: 'image/webp',
              data: imageBytes.toString('base64'),
            },
          ],
        },
      ],
    });
    const coreServices = vi
      .spyOn(lobuGateway, 'getLobuCoreServices')
      .mockReturnValue({ getArtifactStore: () => artifactStore });
    try {
      await streamContent(ctx);
    } finally {
      coreServices.mockRestore();
    }
    expect(result()).toMatchObject({ status: 200, body: { total_items: 1 } });

    const [event] = await sql`
      SELECT id, attachments
      FROM events
      WHERE organization_id = ${org.id}
        AND origin_id = 'mcp-media-event'
      ORDER BY id DESC
      LIMIT 1
    `;
    const eventId = Number(event!.id);
    const attachment = (
      event!.attachments as Array<Record<string, unknown>>
    )[0]!;
    const artifactId = String(attachment.artifact_id);
    expect(
      await artifactStore.read(artifactId, {
        binding: eventArtifactBinding({
          organizationId: org.id,
          connectionId,
          feedId,
          originId: 'mcp-media-event',
        }),
      }),
    ).toBeTruthy();
    expect(
      await artifactStore.read(artifactId, {
        binding: eventArtifactBinding({
          organizationId: org.id,
          feedId,
          originId: 'mcp-media-event',
        }),
      }),
    ).toBeNull();

    const artifactsBeforeUnchangedRetry = await readArtifactIds(artifactsDir);
    const unchangedRetry = mockWorkerCtx({
      run_id: runId,
      worker_id: 'worker-mcp-media',
      items: [
        {
          id: 'mcp-media-event',
          title: 'Memory photo',
          payload_text: 'A streamed photo',
          payload_type: 'media',
          occurred_at: occurredAt,
          attachments: [
            {
              kind: 'image',
              filename: 'memory-photo.webp',
              mime_type: 'image/webp',
              data: imageBytes.toString('base64'),
            },
          ],
        },
      ],
    });
    const retryServices = vi
      .spyOn(lobuGateway, 'getLobuCoreServices')
      .mockReturnValue({ getArtifactStore: () => artifactStore });
    try {
      await streamContent(unchangedRetry.ctx);
    } finally {
      retryServices.mockRestore();
    }
    expect(unchangedRetry.result()).toMatchObject({
      status: 200,
      body: { total_items: 1 },
    });
    const [unchangedCount] = await sql`
      SELECT count(*)::int AS count
      FROM events
      WHERE organization_id = ${org.id}
        AND connection_id = ${connectionId}
        AND origin_id = 'mcp-media-event'
    `;
    expect(Number(unchangedCount!.count)).toBe(1);
    expect(await readArtifactIds(artifactsDir)).toEqual(
      artifactsBeforeUnchangedRetry,
    );

    const failedCleanupRetry = mockWorkerCtx({
      run_id: runId,
      worker_id: 'worker-mcp-media',
      items: [
        {
          id: 'mcp-media-event',
          title: 'Memory photo',
          payload_text: 'A streamed photo',
          payload_type: 'media',
          occurred_at: occurredAt,
          attachments: [
            {
              kind: 'image',
              filename: 'memory-photo.webp',
              mime_type: 'image/webp',
              data: imageBytes.toString('base64'),
            },
          ],
        },
      ],
    });
    const deleteSpy = vi
      .spyOn(artifactStore, 'delete')
      .mockRejectedValueOnce(new Error('injected retained-PVC cleanup failure'));
    const failedCleanupServices = vi
      .spyOn(lobuGateway, 'getLobuCoreServices')
      .mockReturnValue({ getArtifactStore: () => artifactStore });
    try {
      await streamContent(failedCleanupRetry.ctx);
    } finally {
      failedCleanupServices.mockRestore();
      deleteSpy.mockRestore();
    }
    expect(failedCleanupRetry.result()).toMatchObject({
      status: 500,
      body: {
        error: expect.stringContaining(
          'injected retained-PVC cleanup failure',
        ),
      },
    });
    for (const candidateId of await readArtifactIds(artifactsDir)) {
      if (!artifactsBeforeUnchangedRetry.includes(candidateId)) {
        await artifactStore.delete(candidateId);
      }
    }
    expect(await readArtifactIds(artifactsDir)).toEqual(
      artifactsBeforeUnchangedRetry,
    );

    const sessionId = await initSession();
    const path = `/mcp/${org.slug}`;
    const response = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'event-media',
        method: 'tools/call',
        params: {
          name: 'run_sdk',
          arguments: {
            script: `export default async (_ctx, client) => client.knowledge.read({ content_ids: [${eventId}] });`,
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const resource = body.result?.content?.find(
      (item: { type?: string }) => item.type === 'resource_link',
    );
    expect(resource).toEqual(
      expect.objectContaining({
        type: 'resource_link',
        uri: `lobu://event/${eventId}/attachment/0`,
        name: 'memory-photo.webp',
        mimeType: 'image/webp',
        size: imageBytes.length,
      }),
    );

    const readResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'read-event-media',
        method: 'resources/read',
        params: { uri: resource.uri },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const readBody = await readResponse.json();
    expect(readBody.result?.contents?.[0]).toEqual({
      uri: resource.uri,
      mimeType: 'image/webp',
      blob: imageBytes.toString('base64'),
    });

    const artifactsBeforeFailedInsert = await readArtifactIds(artifactsDir);
    const failedInsert = mockWorkerCtx({
      run_id: runId,
      worker_id: 'worker-mcp-media',
      items: [
        {
          id: 'mcp-media-invalid-event',
          title: 'Invalid streamed photo',
          payload_text: 'This insert must fail',
          payload_type: 'media',
          occurred_at: 'not-a-timestamp',
          attachments: [
            {
              kind: 'image',
              filename: 'invalid.webp',
              mime_type: 'image/webp',
              data: Buffer.from('must-be-cleaned').toString('base64'),
            },
          ],
        },
      ],
    });
    const failedInsertServices = vi
      .spyOn(lobuGateway, 'getLobuCoreServices')
      .mockReturnValue({ getArtifactStore: () => artifactStore });
    try {
      await streamContent(failedInsert.ctx);
    } finally {
      failedInsertServices.mockRestore();
    }
    expect(failedInsert.result().status).toBe(500);
    expect(await readArtifactIds(artifactsDir)).toEqual(
      artifactsBeforeFailedInsert,
    );
  });

  it('does not let a resource URI bypass workspace authorization', async () => {
    const otherOrg = await createTestOrganization({
      name: 'Other MCP Media Org',
      slug: 'other-mcp-media-org',
    });
    const bytes = Buffer.from('other-workspace-image');
    const artifact = await artifactStore.publish({
      buffer: bytes,
      filename: 'private.jpg',
      contentType: 'image/jpeg',
      publicGatewayUrl: 'http://localhost',
      binding: eventArtifactBinding({
        organizationId: otherOrg.id,
        originId: 'other-mcp-media-event',
      }),
    });
    const event = await insertEvent({
      entityIds: [],
      organizationId: otherOrg.id,
      originId: 'other-mcp-media-event',
      title: 'Other workspace photo',
      payloadType: 'media',
      content: '',
      semanticType: 'photo',
      attachments: [
        {
          kind: 'image',
          filename: 'private.jpg',
          mime_type: 'image/jpeg',
          artifact_id: artifact.artifactId,
          size_bytes: bytes.length,
        },
      ],
    });

    const sessionId = await initSession();
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'cross-org-media',
        method: 'resources/read',
        params: { uri: `lobu://event/${event.id}/attachment/0` },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBeUndefined();
    expect(body.error?.message).toContain('Unknown resource');
  });

  it('fails safely for invalid, missing, and oversized resources', async () => {
    const oversizedBytes = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    const artifact = await artifactStore.publish({
      buffer: oversizedBytes,
      filename: 'oversized.bin',
      contentType: 'application/octet-stream',
      publicGatewayUrl: 'http://localhost',
      binding: eventArtifactBinding({
        organizationId: org.id,
        originId: 'oversized-mcp-media-event',
      }),
    });
    const event = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'oversized-mcp-media-event',
      title: 'Oversized attachment',
      payloadType: 'media',
      content: '',
      semanticType: 'file',
      attachments: [
        {
          kind: 'file',
          filename: 'oversized.bin',
          mime_type: 'application/octet-stream',
          artifact_id: artifact.artifactId,
          size_bytes: oversizedBytes.length,
        },
      ],
    });
    const sessionId = await initSession();
    const path = `/mcp/${org.slug}`;

    for (const uri of [
      'lobu://event/not-a-number/attachment/0',
      `lobu://event/${event.id}/attachment/99`,
    ]) {
      const response = await post(path, {
        body: {
          jsonrpc: '2.0',
          id: `invalid-${uri}`,
          method: 'resources/read',
          params: { uri },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const body = await response.json();
      expect(body.result).toBeUndefined();
      expect(body.error?.message).toContain('Unknown resource');
    }

    const oversizedResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'oversized-resource',
        method: 'resources/read',
        params: { uri: `lobu://event/${event.id}/attachment/0` },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const oversizedBody = await oversizedResponse.json();
    expect(oversizedBody.result).toBeUndefined();
    expect(oversizedBody.error?.message).toContain('Unknown resource');
  });

  it('retains a checkpointed action artifact after terminalization rollback without publishing on a terminal retry', async () => {
    const sql = getDb();
    const [rollbackRun, finalizedRun] = await Promise.all([
      sql`
        INSERT INTO runs (
          organization_id, run_type, status, approval_status, claimed_by, action_key
        ) VALUES (
          ${org.id}, 'action', 'running', 'approved', 'worker-media-cleanup', 'capture'
        )
        RETURNING id
      `.then((rows) => rows[0]),
      sql`
        INSERT INTO runs (
          organization_id, run_type, status, approval_status, claimed_by, action_key
        ) VALUES (
          ${org.id}, 'action', 'completed', 'auto', 'worker-media-cleanup', 'capture'
        )
        RETURNING id
      `.then((rows) => rows[0]),
    ]);
    const artifactsBefore = await readArtifactIds(artifactsDir);
    const coreServices = vi
      .spyOn(lobuGateway, 'getLobuCoreServices')
      .mockReturnValue({ getArtifactStore: () => artifactStore });

    try {
      const rollback = mockWorkerCtx({
        run_id: Number(rollbackRun!.id),
        worker_id: 'worker-media-cleanup',
        status: 'success',
        action_output: {
          attachments: [
            {
              filename: 'rollback.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('rollback-artifact').toString('base64'),
            },
          ],
        },
      });
      await completeActionRun(rollback.ctx);
      expect(rollback.result().status).toBe(500);
      expect((rollback.result().body as { error?: string }).error).toContain(
        'approval card is missing',
      );

      const zeroRows = mockWorkerCtx({
        run_id: Number(finalizedRun!.id),
        worker_id: 'worker-media-cleanup',
        status: 'success',
        action_output: {
          attachments: [
            {
              filename: 'already-finalized.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('zero-row-artifact').toString('base64'),
            },
          ],
        },
      });
      await completeActionRun(zeroRows.ctx);
      expect(zeroRows.result()).toMatchObject({
        status: 200,
        body: { success: true },
      });
    } finally {
      coreServices.mockRestore();
    }

    const [runAfterRollback] = await sql`
      SELECT status, action_output FROM runs WHERE id = ${Number(rollbackRun!.id)}
    `;
    expect(runAfterRollback!.status).toBe('running');
    const checkpointedAttachment = (
      runAfterRollback!.action_output as {
        attachments: Array<Record<string, unknown>>;
      }
    ).attachments[0]!;
    expect(checkpointedAttachment).toHaveProperty('artifact_id');
    expect(checkpointedAttachment).not.toHaveProperty('data');
    expect(
      await artifactStore.read(String(checkpointedAttachment.artifact_id), {
        binding: runArtifactBinding(Number(rollbackRun!.id)),
      }),
    ).toBeTruthy();
    expect(await readArtifactIds(artifactsDir)).toEqual(
      [...artifactsBefore, String(checkpointedAttachment.artifact_id)].sort(),
    );
  });

  it('rejects an artifact grafted from another authorized resource', async () => {
    const otherOrg = await createTestOrganization({
      name: 'Foreign Artifact Org',
      slug: 'foreign-artifact-org',
    });
    const sql = getDb();
    const [foreignRun, localRun] = await Promise.all([
      sql`
        INSERT INTO runs (organization_id, run_type, status, approval_status)
        VALUES (${otherOrg.id}, 'action', 'completed', 'auto')
        RETURNING id
      `.then((rows) => rows[0]),
      sql`
        INSERT INTO runs (organization_id, run_type, status, approval_status)
        VALUES (${org.id}, 'action', 'completed', 'auto')
        RETURNING id
      `.then((rows) => rows[0]),
    ]);
    const foreignRunId = Number(foreignRun!.id);
    const localRunId = Number(localRun!.id);
    const foreignBytes = Buffer.from('foreign-artifact-bytes');
    const foreignArtifact = await artifactStore.publish({
      buffer: foreignBytes,
      filename: 'foreign.jpg',
      contentType: 'image/jpeg',
      publicGatewayUrl: 'http://localhost',
      binding: runArtifactBinding(foreignRunId),
    });
    await sql`
      UPDATE runs
      SET action_output = ${sql.json({
        attachments: [
          {
            kind: 'image',
            filename: 'foreign.jpg',
            mime_type: 'image/jpeg',
            artifact_id: foreignArtifact.artifactId,
            size_bytes: foreignBytes.length,
          },
        ],
      })}
      WHERE id = ${localRunId}
    `;

    const sessionId = await initSession();
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'grafted-media',
        method: 'resources/read',
        params: { uri: `lobu://run/${localRunId}/attachment/0` },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBeUndefined();
    expect(body.error?.message).toContain('Unknown resource');
  });

  it('returns operation attachments as stable resource links and serves their bytes', async () => {
    const imageBytes = Buffer.from('fake-image-bytes');
    const sql = getDb();
    const [run] = await sql`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status
      ) VALUES (
        ${org.id}, 'action', 'completed', 'auto'
      )
      RETURNING id
    `;
    const runId = Number(run!.id);
    const artifact = await artifactStore.publish({
      buffer: imageBytes,
      filename: 'candidate.jpg',
      contentType: 'image/jpeg',
      publicGatewayUrl: 'http://localhost',
      ttlMs: -1,
      binding: runArtifactBinding(runId),
    });
    const expiredToken = new URL(artifact.downloadUrl).searchParams.get(
      'token',
    );
    expect(expiredToken).toBeTruthy();
    expect(
      artifactStore.validateDownloadToken(expiredToken!, artifact.artifactId)
        .valid,
    ).toBe(false);
    await sql`
      UPDATE runs
      SET action_output = ${sql.json({
        attachments: [
          {
            kind: 'image',
            filename: 'candidate.jpg',
            mime_type: 'image/jpeg',
            artifact_id: artifact.artifactId,
            download_url: artifact.downloadUrl,
            size_bytes: imageBytes.length,
          },
        ],
      })}
      WHERE id = ${runId}
    `;

    const sessionId = await initSession();
    const path = `/mcp/${org.slug}`;
    const response = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'operation-media',
        method: 'tools/call',
        params: {
          name: 'run_sdk',
          arguments: {
            script: `export default async (_ctx, client) => client.operations.getRun(${runId});`,
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    const resource = body.result?.content?.find(
      (item: { type?: string }) => item.type === 'resource_link',
    );
    expect(resource).toEqual(
      expect.objectContaining({
        type: 'resource_link',
        uri: `lobu://run/${runId}/attachment/0`,
        name: 'candidate.jpg',
        mimeType: 'image/jpeg',
        size: imageBytes.length,
      }),
    );

    const readResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'read-operation-media',
        method: 'resources/read',
        params: { uri: resource.uri },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    expect(readResponse.status).toBe(200);
    const readBody = await readResponse.json();
    expect(readBody.result?.contents?.[0]).toEqual({
      uri: resource.uri,
      mimeType: 'image/jpeg',
      blob: imageBytes.toString('base64'),
    });
  });
});

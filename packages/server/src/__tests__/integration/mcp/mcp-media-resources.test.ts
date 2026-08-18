import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  ArtifactStore,
  eventArtifactBinding,
  runArtifactBinding,
} from '../../../gateway/files/artifact-store';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { insertEvent } from '../../../utils/insert-event';
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

describe('MCP media resources', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let token: string;
  let artifactStore: ArtifactStore;
  let artifactsDir: string;
  const previousArtifactsDir = process.env.LOBU_ARTIFACTS_DIR;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeAll(async () => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'lobu-mcp-media-'));
    process.env.LOBU_ARTIFACTS_DIR = artifactsDir;
    process.env.ENCRYPTION_KEY = Buffer.from(
      '12345678901234567890123456789012'
    ).toString('base64');
    artifactStore = new ArtifactStore();

    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({
      name: 'MCP Media Org',
      slug: 'mcp-media-org',
    });
    const owner = await createTestUser({ email: 'mcp-media-owner@test.example.com' });
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
    if (previousArtifactsDir === undefined) delete process.env.LOBU_ARTIFACTS_DIR;
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

  it('returns durable event attachments as MCP resources', async () => {
    const imageBytes = Buffer.from('durable-event-image');
    const artifact = await artifactStore.publish({
      buffer: imageBytes,
      filename: 'memory-photo.webp',
      contentType: 'image/webp',
      publicGatewayUrl: 'http://localhost',
      binding: eventArtifactBinding({
        organizationId: org.id,
        originId: 'mcp-media-event',
      }),
    });
    const event = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'mcp-media-event',
      title: 'Memory photo',
      payloadType: 'media',
      content: '',
      semanticType: 'photo',
      attachments: [
        {
          kind: 'image',
          filename: 'memory-photo.webp',
          mime_type: 'image/webp',
          artifact_id: artifact.artifactId,
          download_url: artifact.downloadUrl,
          size_bytes: imageBytes.length,
        },
      ],
    });

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
            script: `export default async (_ctx, client) => client.knowledge.read({ content_ids: [${event.id}] });`,
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const resource = body.result?.content?.find(
      (item: { type?: string }) => item.type === 'resource_link'
    );
    expect(resource).toEqual(
      expect.objectContaining({
        type: 'resource_link',
        uri: `lobu://event/${event.id}/attachment/0`,
        name: 'memory-photo.webp',
        mimeType: 'image/webp',
        size: imageBytes.length,
      })
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
      binding: runArtifactBinding(runId),
    });
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
      (item: { type?: string }) => item.type === 'resource_link'
    );
    expect(resource).toEqual(
      expect.objectContaining({
        type: 'resource_link',
        uri: `lobu://run/${runId}/attachment/0`,
        name: 'candidate.jpg',
        mimeType: 'image/jpeg',
        size: imageBytes.length,
      })
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

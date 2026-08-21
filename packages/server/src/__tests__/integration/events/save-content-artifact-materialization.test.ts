/**
 * Integration test: save_memory materializes inline media into the
 * ArtifactStore before writing the event, the way connector ingest already
 * does.
 *
 * Two things were wrong before. `events` was the binary store for anything an
 * agent saved with attachments — the base64 stayed in the row. And the
 * attachment was whatever the caller handed us, so an agent could write an
 * arbitrary `artifact_id` into an event it controls; nothing bound the
 * reference to the event it lived on.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ArtifactStore,
  eventArtifactBinding,
} from '../../../gateway/files/artifact-store';
import * as lobuGateway from '../../../lobu/gateway';
import * as insertEventModule from '../../../utils/insert-event';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > inline attachment materialization', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entityId: number;
  let artifactsDir: string;
  let artifactStore: ArtifactStore;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Artifact Materialization Org' });
    user = await createTestUser({ email: 'artifact-materialize@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({
      name: 'Artifact Materialization Entity',
      organization_id: org.id,
    });
    entityId = entity.id;

    artifactsDir = mkdtempSync(join(tmpdir(), 'lobu-save-content-artifacts-'));
    process.env.ENCRYPTION_KEY = Buffer.from(
      '12345678901234567890123456789012'
    ).toString('base64');
    artifactStore = new ArtifactStore(artifactsDir);
    vi.spyOn(lobuGateway, 'getLobuCoreServices').mockReturnValue({
      getArtifactStore: () => artifactStore,
    } as ReturnType<typeof lobuGateway.getLobuCoreServices>);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
      sourceContext: null,
    } as ToolContext;
  }

  it('stores the bytes as a bound artifact and leaves a reference on the event', async () => {
    const bytes = Buffer.from('saved-memory-image-bytes');

    const result = await saveContent(
      {
        entity_ids: [entityId],
        title: 'photo note',
        content: 'a photo',
        semantic_type: 'note',
        attachments: [
          {
            kind: 'image',
            filename: 'note.jpg',
            mime_type: 'image/jpeg',
            data: bytes.toString('base64'),
            size_bytes: bytes.length,
          },
        ],
      } as never,
      {} as never,
      ctx()
    );

    const eventId = Number((result as { id: number | string }).id);
    const sql = getTestDb();
    const [row] = await sql`
      SELECT origin_id, attachments FROM events WHERE id = ${eventId}
    `;
    const stored = (row.attachments as Array<Record<string, unknown>>)[0];

    // The bytes are gone from the row.
    expect(stored).not.toHaveProperty('data');
    expect(stored.artifact_id).toEqual(expect.any(String));
    expect(stored.sha256).toEqual(expect.any(String));
    expect(stored.size_bytes).toBe(bytes.length);

    // …and readable from the store only under this event's binding.
    const binding = eventArtifactBinding({
      organizationId: org.id,
      originId: String(row.origin_id),
    });
    const bound = await artifactStore.read(String(stored.artifact_id), { binding });
    expect(bound?.bytes.equals(bytes)).toBe(true);

    const wrongBinding = await artifactStore.read(String(stored.artifact_id), {
      binding: eventArtifactBinding({
        organizationId: org.id,
        originId: 'some-other-event',
      }),
    });
    expect(wrongBinding).toBeNull();
  });

  it('deletes what it published when the insert fails', async () => {
    // Publishing escapes the insert, so a row that never lands leaves bytes on
    // the volume with no owner unless the failure path reclaims them.
    const before = readdirSync(artifactsDir);
    const bytes = Buffer.from('bytes-for-a-doomed-insert');
    const insertSpy = vi
      .spyOn(insertEventModule, 'insertEvent')
      .mockRejectedValueOnce(new Error('insert exploded'));

    await expect(
      saveContent(
        {
          entity_ids: [entityId],
          title: 'doomed',
          content: 'doomed',
          semantic_type: 'note',
          attachments: [
            {
              kind: 'image',
              filename: 'doomed.jpg',
              mime_type: 'image/jpeg',
              data: bytes.toString('base64'),
              size_bytes: bytes.length,
            },
          ],
        } as never,
        {} as never,
        ctx()
      )
    ).rejects.toThrow('insert exploded');

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(readdirSync(artifactsDir).sort()).toEqual(before.sort());
    insertSpy.mockRestore();
  });

  it('passes through an attachment that carries no inline bytes', async () => {
    const result = await saveContent(
      {
        entity_ids: [entityId],
        title: 'link note',
        content: 'a link',
        semantic_type: 'note',
        attachments: [{ kind: 'file', filename: 'remote.pdf', url: 'https://example/remote.pdf' }],
      } as never,
      {} as never,
      ctx()
    );

    const eventId = Number((result as { id: number | string }).id);
    const sql = getTestDb();
    const [row] = await sql`SELECT attachments FROM events WHERE id = ${eventId}`;
    const stored = (row.attachments as Array<Record<string, unknown>>)[0];

    expect(stored).toEqual({
      kind: 'file',
      filename: 'remote.pdf',
      url: 'https://example/remote.pdf',
    });
  });
});

/**
 * Issue #3067 reproducer: transcription enriches one connector event version.
 *
 * Source identity is (connection_id, origin_id), and a transcript is the next
 * version of that same source item. It must never select another connection's
 * colliding origin or fork the chain under a synthetic origin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lobuGateway from '../../../lobu/gateway';
import { transcribeOne } from '../../../utils/inline-attachments';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestOrganization,
} from '../../setup/test-fixtures';

const ORIGIN_ID = 'provider-message-42';
const previousEmbeddingsServiceUrl = process.env.EMBEDDINGS_SERVICE_URL;
const previousEmbeddingsModel = process.env.EMBEDDINGS_MODEL;

function transcriptionJob(
  eventId: number,
  connectionId: number,
  title: string | null = null
): Parameters<typeof transcribeOne>[0] {
  return {
    originId: ORIGIN_ID,
    baseEventId: eventId,
    connectionId,
    artifactId: `artifact-${eventId}`,
    mimeType: 'audio/opus',
    title,
  };
}

async function currentHeads(organizationId: string) {
  const sql = getTestDb();
  return (await sql`
    SELECT id, origin_id, payload_text, connector_key, connection_id,
           feed_key, feed_id, run_id, origin_parent_id
    FROM events e
    WHERE organization_id = ${organizationId}
      AND NOT EXISTS (
        SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id
      )
    ORDER BY connection_id, id
  `) as Array<{
    id: number | string;
    origin_id: string;
    payload_text: string | null;
    connector_key: string | null;
    connection_id: number | string | null;
    feed_key: string | null;
    feed_id: number | string | null;
    run_id: number | string | null;
    origin_parent_id: string | null;
  }>;
}

async function createFeed(
  organizationId: string,
  connectionId: number,
  feedKey: string
): Promise<number> {
  const [row] = await getTestDb()`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status, created_at, updated_at
    ) VALUES (
      ${organizationId}, ${connectionId}, ${feedKey}, 'active', NOW(), NOW()
    )
    RETURNING id
  `;
  return Number(row!.id);
}

async function createRun(organizationId: string): Promise<number> {
  const [row] = await getTestDb()`
    INSERT INTO runs (
      organization_id, run_type, status, approval_status, action_key, created_at
    ) VALUES (
      ${organizationId}, 'action', 'pending', 'pending', 'transcribe-test', NOW()
    )
    RETURNING id
  `;
  return Number(row!.id);
}

describe('inline attachment transcription event identity (issue #3067)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.EMBEDDINGS_SERVICE_URL;
    delete process.env.EMBEDDINGS_MODEL;
    vi.spyOn(lobuGateway, 'getLobuCoreServices').mockReturnValue({
      getArtifactStore: () => ({
        read: async () => ({ bytes: Buffer.from('synthetic audio') }),
      }),
      getTranscriptionService: () => ({
        transcribe: async () => ({
          text: 'transcribed voice note',
          provider: 'test-stt',
        }),
      }),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (previousEmbeddingsServiceUrl === undefined) {
      delete process.env.EMBEDDINGS_SERVICE_URL;
    } else {
      process.env.EMBEDDINGS_SERVICE_URL = previousEmbeddingsServiceUrl;
    }
    if (previousEmbeddingsModel === undefined) {
      delete process.env.EMBEDDINGS_MODEL;
    } else {
      process.env.EMBEDDINGS_MODEL = previousEmbeddingsModel;
    }
  });

  it('never selects a colliding origin from another connection', async () => {
    const org = await createTestOrganization();
    const firstConnection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'whatsapp.local',
    });
    const secondConnection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'whatsapp.local',
    });

    const first = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: ORIGIN_ID,
      title: 'First account voice note',
      content: '[voice note from first account]',
      semanticType: 'message',
      connectorKey: 'whatsapp.local',
      connectionId: Number(firstConnection.id),
    });
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: ORIGIN_ID,
      title: 'Second account voice note',
      content: '[voice note from second account]',
      semanticType: 'message',
      connectorKey: 'whatsapp.local',
      connectionId: Number(secondConnection.id),
    });

    await transcribeOne(
      transcriptionJob(Number(first.id), Number(firstConnection.id)),
      org.id,
      'test-agent'
    );

    const heads = await currentHeads(org.id);
    expect(heads).toHaveLength(2);
    expect(heads).toEqual([
      expect.objectContaining({
        origin_id: ORIGIN_ID,
        payload_text: 'transcribed voice note',
        connection_id: Number(firstConnection.id),
      }),
      expect.objectContaining({
        origin_id: ORIGIN_ID,
        payload_text: '[voice note from second account]',
        connection_id: Number(secondConnection.id),
      }),
    ]);
  });

  it('keeps transcription and resync in one same-origin lineage', async () => {
    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'whatsapp.local',
    });
    const connectionId = Number(connection.id);
    const feedId = await createFeed(org.id, connectionId, 'messages');
    const runId = await createRun(org.id);
    const baseParams = {
      entityIds: [],
      organizationId: org.id,
      originId: ORIGIN_ID,
      title: 'Voice note',
      content: '[voice note]',
      semanticType: 'message' as const,
      originType: 'message',
      connectorKey: 'whatsapp.local',
      connectionId,
      feedKey: 'messages',
      feedId,
      runId,
      parentOriginId: 'conversation-7',
    };
    const base = await insertEvent(baseParams, { onConflictUpdate: true });

    await transcribeOne(transcriptionJob(Number(base.id), connectionId), org.id, 'test-agent');
    const afterTranscript = await currentHeads(org.id);
    expect(afterTranscript).toHaveLength(1);
    expect(afterTranscript[0]).toMatchObject({
      origin_id: ORIGIN_ID,
      payload_text: 'transcribed voice note',
      connector_key: 'whatsapp.local',
      connection_id: connectionId,
      feed_key: 'messages',
      feed_id: feedId,
      run_id: runId,
      origin_parent_id: 'conversation-7',
    });

    const resync = await insertEvent(baseParams, { onConflictUpdate: true });
    expect(resync.change).toBe('superseded');
    await transcribeOne(
      transcriptionJob(Number(resync.id), connectionId),
      org.id,
      'test-agent'
    );

    const heads = await currentHeads(org.id);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      origin_id: ORIGIN_ID,
      payload_text: 'transcribed voice note',
      connector_key: 'whatsapp.local',
      connection_id: connectionId,
      feed_key: 'messages',
      feed_id: feedId,
      run_id: runId,
      origin_parent_id: 'conversation-7',
    });

    const chain = await getTestDb()`
      SELECT origin_id, supersedes_event_id, superseded_by
      FROM events
      WHERE organization_id = ${org.id}
        AND connection_id = ${connectionId}
      ORDER BY id
    `;
    expect(chain).toHaveLength(4);
    expect(chain.every((row) => row.origin_id === ORIGIN_ID)).toBe(true);
    expect(chain.filter((row) => row.superseded_by == null)).toHaveLength(1);
  });

  it('serializes duplicate transcription completion for the same event version', async () => {
    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'whatsapp.local',
    });
    const connectionId = Number(connection.id);
    const base = await insertEvent(
      {
        entityIds: [],
        organizationId: org.id,
        originId: ORIGIN_ID,
        title: 'Concurrent voice note',
        content: '[voice note]',
        semanticType: 'message',
        connectorKey: 'whatsapp.local',
        connectionId,
      },
      { onConflictUpdate: true }
    );
    const job = transcriptionJob(Number(base.id), connectionId);

    await Promise.all([
      transcribeOne(job, org.id, 'test-agent'),
      transcribeOne(job, org.id, 'test-agent'),
    ]);

    const heads = await currentHeads(org.id);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      origin_id: ORIGIN_ID,
      payload_text: 'transcribed voice note',
      connection_id: connectionId,
    });
    const [count] = await getTestDb()`
      SELECT count(*)::int AS count
      FROM events
      WHERE organization_id = ${org.id}
        AND connection_id = ${connectionId}
        AND origin_id = ${ORIGIN_ID}
    `;
    expect(count!.count).toBe(2);
  });

  it('drops a stale transcript when a normal resync replaces its exact base', async () => {
    let transcriptionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transcriptionStarted = resolve;
    });
    let finishTranscription!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      finishTranscription = resolve;
    });
    vi.mocked(lobuGateway.getLobuCoreServices).mockReturnValue({
      getArtifactStore: () => ({
        read: async () => ({ bytes: Buffer.from('old synthetic audio') }),
      }),
      getTranscriptionService: () => ({
        transcribe: async () => {
          transcriptionStarted();
          await mayFinish;
          return { text: 'stale transcript', provider: 'test-stt' };
        },
      }),
    } as never);

    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'whatsapp.local',
    });
    const connectionId = Number(connection.id);
    const baseParams = {
      entityIds: [],
      organizationId: org.id,
      originId: ORIGIN_ID,
      title: 'Voice note',
      content: '[old voice note]',
      semanticType: 'message' as const,
      connectorKey: 'whatsapp.local',
      connectionId,
    };
    const base = await insertEvent(baseParams, { onConflictUpdate: true });

    const transcribing = transcribeOne(
      transcriptionJob(Number(base.id), connectionId),
      org.id,
      'test-agent'
    );
    await started;
    const resync = await insertEvent(
      { ...baseParams, content: '[new voice note]' },
      { onConflictUpdate: true }
    );
    expect(resync.change).toBe('superseded');
    finishTranscription();
    await transcribing;

    const heads = await currentHeads(org.id);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      origin_id: ORIGIN_ID,
      payload_text: '[new voice note]',
      connection_id: connectionId,
    });
    const [count] = await getTestDb()`
      SELECT count(*)::int AS count
      FROM events
      WHERE organization_id = ${org.id}
        AND connection_id = ${connectionId}
        AND origin_id = ${ORIGIN_ID}
    `;
    expect(count!.count).toBe(2);
  });

  it('stamps the transcript vector through the canonical insertEvent path', async () => {
    const embeddingModel = 'test/transcription-768d';
    const embedding = new Array<number>(768).fill(0);
    embedding[17] = 1;
    process.env.EMBEDDINGS_SERVICE_URL = 'http://embeddings.test';
    process.env.EMBEDDINGS_MODEL = embeddingModel;
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          embeddings: [embedding],
          dimensions: 768,
          model: embeddingModel,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'whatsapp.local',
    });
    const connectionId = Number(connection.id);
    const base = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: ORIGIN_ID,
      title: 'Embedded voice note',
      content: '[voice note]',
      semanticType: 'message',
      connectorKey: 'whatsapp.local',
      connectionId,
    });

    await transcribeOne(
      transcriptionJob(Number(base.id), connectionId, 'Embedded voice note'),
      org.id,
      'test-agent'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      texts: ['Embedded voice note transcribed voice note'],
      model: embeddingModel,
    });
    const [vectorRow] = await getTestDb()`
      SELECT ee.embedding_model
      FROM event_embeddings ee
      JOIN events e ON e.id = ee.event_id
      WHERE e.organization_id = ${org.id}
        AND e.connection_id = ${connectionId}
        AND e.origin_id = ${ORIGIN_ID}
        AND e.superseded_by IS NULL
    `;
    expect(vectorRow).toEqual({ embedding_model: embeddingModel });
  });
});

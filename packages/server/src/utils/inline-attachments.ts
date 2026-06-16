/**
 * Connector-emitted inline attachments → ArtifactStore + transcription.
 *
 * Connectors (today: the Mac bridge's whatsapp.local) ship binary attachments
 * inline inside a stream batch:
 *
 *   { kind: 'audio', filename: 'AUD-…opus', mime_type: 'audio/opus',
 *     data: '<base64 bytes>', size_bytes: 23456 }
 *
 * Before the row hits `events.attachments` we strip the bytes out — events
 * are not a binary store — and put them in the ArtifactStore, then leave a
 * lightweight reference behind:
 *
 *   { kind: 'audio', filename: '…', mime_type: '…', artifact_id: '<uuid>',
 *     download_url: 'https://…/lobu/api/v1/files/<id>?token=…',
 *     size_bytes: 23456 }
 *
 * Audio attachments additionally enqueue background transcription via
 * TranscriptionService. On success a superseding event is written so the
 * `current_event_records` view exposes the transcribed text. Failures are
 * swallowed — the unsuperseded `[voice note]` placeholder remains usable.
 */
import { readFile } from "node:fs/promises";
import { getDb } from "../db/client";
import { getLobuCoreServices } from "../lobu/gateway";
import { getConfiguredPublicOrigin } from "./public-origin";
import { insertEvent } from "./insert-event";
import logger from "./logger";

/**
 * Hard cap on a single decoded attachment we'll publish. Server-side guard so
 * a compromised or buggy worker can't force unbounded memory + artifact-store
 * writes. Matches the Mac bridge's client-side 2MB cap for voice notes; if a
 * future connector legitimately needs to ship something larger, push it
 * through a multipart upload endpoint instead of inline base64.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 2 * 1024 * 1024;

interface InlineAttachment {
  kind?: string;
  filename?: string;
  mime_type?: string;
  data?: string;
  size_bytes?: number;
  duration_ms?: number | null;
  [extra: string]: unknown;
}

interface MaterializedAttachment {
  kind: string;
  filename: string;
  mime_type: string;
  artifact_id: string;
  download_url: string;
  size_bytes: number;
  duration_ms?: number | null;
}

interface StreamItemLike {
  id: string;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
}

/** Per-item record of audio attachments that the gateway should transcribe. */
interface AudioTranscriptionPending {
  originId: string;
  artifactId: string;
  filename: string;
  mimeType: string;
}

function publicGatewayUrl(): string {
  const origin =
    getConfiguredPublicOrigin() ||
    `http://localhost:${process.env.PORT || "8787"}`;
  return new URL("/lobu/", origin).toString().replace(/\/$/, "");
}

/**
 * Walk a batch of stream items, replace any inline base64 `data` on
 * attachments with an ArtifactStore reference, and return the rewritten items
 * plus a list of audio attachments to transcribe after insert.
 *
 * Items without attachments pass through unchanged. Attachments missing
 * `data` are also passed through (a connector may pre-publish and reference
 * an existing artifact).
 */
export async function materializeInlineAttachments<T extends StreamItemLike>(
  items: T[]
): Promise<{ items: T[]; pendingTranscriptions: AudioTranscriptionPending[] }> {
  const coreServices = getLobuCoreServices();
  const artifactStore = coreServices?.getArtifactStore?.();
  if (!artifactStore) {
    return { items, pendingTranscriptions: [] };
  }

  const baseUrl = publicGatewayUrl();
  const pendingTranscriptions: AudioTranscriptionPending[] = [];
  const out: T[] = [];

  for (const item of items) {
    const attachments = item.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) {
      out.push(item);
      continue;
    }

    const rewritten: unknown[] = [];
    for (const raw of attachments) {
      if (!raw || typeof raw !== "object") {
        rewritten.push(raw);
        continue;
      }
      const att = raw as InlineAttachment;
      if (!att.data || typeof att.data !== "string") {
        rewritten.push(att);
        continue;
      }
      const filename = att.filename || "attachment";
      const mime = att.mime_type || "application/octet-stream";
      const kind = att.kind || inferKindFromMime(mime);
      // `Buffer.from(str, 'base64')` never throws on malformed input — it
      // silently ignores non-base64 chars. An empty result is the only signal
      // we get that the input was junk, so guard on length here.
      const buffer = Buffer.from(att.data, "base64");
      if (buffer.length === 0) {
        logger.warn(
          { item_id: item.id },
          "[inline-attachments] base64 decoded to 0 bytes — dropping attachment"
        );
        continue;
      }
      if (buffer.length > MAX_INLINE_ATTACHMENT_BYTES) {
        logger.warn(
          {
            item_id: item.id,
            size_bytes: buffer.length,
            cap: MAX_INLINE_ATTACHMENT_BYTES,
          },
          "[inline-attachments] attachment exceeds server cap — dropping attachment"
        );
        continue;
      }

      const published = await artifactStore.publish({
        buffer,
        filename,
        contentType: mime,
        publicGatewayUrl: baseUrl,
      });

      const materialized: MaterializedAttachment = {
        kind,
        filename: published.filename,
        mime_type: published.contentType,
        artifact_id: published.artifactId,
        download_url: published.downloadUrl,
        size_bytes: published.size,
        duration_ms: att.duration_ms ?? null,
      };
      rewritten.push(materialized);

      if (kind === "audio") {
        pendingTranscriptions.push({
          originId: item.id,
          artifactId: published.artifactId,
          filename: published.filename,
          mimeType: published.contentType,
        });
      }
    }

    out.push({ ...item, attachments: rewritten });
  }

  return { items: out, pendingTranscriptions };
}

function inferKindFromMime(mime: string): string {
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/**
 * Fire-and-forget transcription for each audio attachment that was just
 * materialized. On success, writes a superseding event whose payload_text
 * carries the transcript, so `current_event_records` exposes the
 * transcribed message while the original `[voice note]` row stays as
 * recoverable history.
 *
 * Picks the first agent in the org whose auth profiles include an STT
 * provider (OpenAI, Gemini, or ElevenLabs). If none exists, leaves the
 * placeholder untouched — graceful degradation.
 */
export function triggerAudioTranscriptions(
  organizationId: string,
  pending: AudioTranscriptionPending[]
): void {
  if (pending.length === 0) return;

  // Fire-and-forget. The outer try/catch is the safety net for anything
  // that escapes the per-job catch below — a DB hiccup in
  // `pickTranscriptionAgent`, an unexpected throw from getLobuCoreServices,
  // etc. — so a transcription failure cannot crash the stream-batch ack
  // that already returned.
  void (async () => {
    try {
      const coreServices = getLobuCoreServices();
      const transcriptionService = coreServices?.getTranscriptionService?.();
      const artifactStore = coreServices?.getArtifactStore?.();
      if (!transcriptionService || !artifactStore) {
        logger.info(
          { organizationId, pending: pending.length },
          "[inline-attachments] transcription skipped — coreServices unavailable"
        );
        return;
      }

      const agentId = await pickTranscriptionAgent(organizationId);
      if (!agentId) {
        logger.info(
          { organizationId, pending: pending.length },
          "[inline-attachments] no STT-capable agent in org — leaving voice-note placeholders"
        );
        return;
      }

      for (const job of pending) {
        try {
          await transcribeOne(job, organizationId, agentId);
        } catch (err) {
          logger.warn(
            { origin_id: job.originId, err: String(err) },
            "[inline-attachments] transcription job failed"
          );
        }
      }
    } catch (err) {
      logger.warn(
        { organizationId, err: String(err) },
        "[inline-attachments] transcription orchestrator threw"
      );
    }
  })();
}

async function pickTranscriptionAgent(
  organizationId: string
): Promise<string | null> {
  const coreServices = getLobuCoreServices();
  const transcriptionService = coreServices?.getTranscriptionService?.();
  if (!transcriptionService) return null;
  const sql = getDb();
  const rows = (await sql`
    SELECT id FROM agents
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
  `) as Array<{ id: string }>;
  for (const row of rows) {
    const cfg = await transcriptionService.getConfig(row.id);
    if (cfg) return row.id;
  }
  return null;
}

async function transcribeOne(
  job: AudioTranscriptionPending,
  organizationId: string,
  agentId: string
): Promise<void> {
  const coreServices = getLobuCoreServices();
  const artifactStore = coreServices!.getArtifactStore();
  const transcriptionService = coreServices!.getTranscriptionService();
  if (!artifactStore || !transcriptionService) return;

  const stored = await artifactStore.read(job.artifactId);
  if (!stored) {
    logger.warn(
      { artifact_id: job.artifactId },
      "[inline-attachments] artifact missing — cannot transcribe"
    );
    return;
  }
  const buffer = await readFile(stored.filePath);

  const result = await transcriptionService.transcribe(
    buffer,
    agentId,
    job.mimeType
  );
  if ("error" in result) {
    logger.info(
      { origin_id: job.originId, error: result.error },
      "[inline-attachments] transcription returned error — keeping placeholder"
    );
    return;
  }

  const transcript = result.text.trim();
  if (!transcript) return;

  const sql = getDb();
  const baseRows = (await sql`
    SELECT id, entity_ids, title, payload_type, payload_data, attachments,
           author_name, source_url, occurred_at, metadata, semantic_type,
           origin_type, connector_key, connection_id, feed_key, feed_id,
           score, origin_parent_id
    FROM events
    WHERE organization_id = ${organizationId}
      AND origin_id = ${job.originId}
      AND NOT EXISTS (
        SELECT 1 FROM events newer WHERE newer.supersedes_event_id = events.id
      )
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `) as Array<{
    id: number;
    entity_ids: number[] | null;
    title: string | null;
    payload_type: string;
    payload_data: Record<string, unknown> | null;
    attachments: unknown[] | null;
    author_name: string | null;
    source_url: string | null;
    occurred_at: string | null;
    metadata: Record<string, unknown> | null;
    semantic_type: string;
    origin_type: string | null;
    connector_key: string | null;
    connection_id: number | null;
    feed_key: string | null;
    feed_id: number | null;
    score: number | null;
    origin_parent_id: string | null;
  }>;
  const base = baseRows[0];
  if (!base) return;

  const meta = { ...(base.metadata ?? {}), transcript_provider: result.provider };

  // Tombstone-style supersede: insert a new event that points at the current
  // row. The `current_event_records` view (and findCurrentEventByOrigin) will
  // surface this one going forward; the original stays in history.
  await insertEvent({
    entityIds: base.entity_ids ?? [],
    organizationId,
    originId: `${job.originId}#transcript`,
    title: base.title,
    payloadType: (base.payload_type as never) || "text",
    content: transcript,
    payloadData: base.payload_data ?? {},
    attachments: base.attachments ?? [],
    authorName: base.author_name,
    sourceUrl: base.source_url,
    occurredAt: base.occurred_at,
    semanticType: base.semantic_type,
    originType: base.origin_type,
    metadata: meta,
    connectorKey: base.connector_key,
    connectionId: base.connection_id,
    feedKey: base.feed_key,
    feedId: base.feed_id,
    parentOriginId: base.origin_parent_id,
    score: base.score,
    supersedesEventId: base.id,
  });
}

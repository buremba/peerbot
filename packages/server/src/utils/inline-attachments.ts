/**
 * Connector-emitted inline attachments → ArtifactStore + transcription.
 *
 * Some connectors ship binary attachments
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
 *     size_bytes: 23456, sha256: '<hex>' }
 *
 * Audio attachments additionally enqueue background transcription via
 * TranscriptionService. On success a superseding event is written so the
 * `current_event_records` view exposes the transcribed text. Failures are
 * swallowed — the unsuperseded `[voice note]` placeholder remains usable.
 */
import { getDb } from "../db/client";
import { getLobuCoreServices } from "../lobu/gateway";
import {
  runArtifactBinding,
  type ArtifactStore,
} from "../gateway/files/artifact-store";
import { resolvePublicGatewayUrl } from "./public-origin";
import {
  insertEvent,
  lockEventDedupIdentity,
} from "./insert-event";
import {
  generateEmbeddings,
  getConfiguredEmbeddingModel,
} from "./embeddings";
import { getEnvFromProcess } from "./env";
import logger from "./logger";

/**
 * Hard cap on a single decoded attachment we'll publish. Server-side guard so
 * a compromised or buggy worker can't force unbounded memory + artifact-store
 * writes.
 *
 * 8MB, not the 2MB the Mac bridge caps voice notes at, because screenshots go
 * through here too and a 2MB cap silently DROPS them (see the `buffer.length >`
 * branch below — it warns and continues). Measured against prod: the Chrome
 * extension's largest screenshot decodes to ~3.1MB and 12 of 424 exceed 2MB,
 * and the Mac capture path peaks at ~1.9MB, within 5% of the old cap. Anything
 * legitimately larger than 8MB belongs in a multipart upload, not inline base64.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

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
  /**
   * Content hash of the published bytes. `artifact_id` and `download_url` are
   * minted fresh on every publication of the same source attachment, so this is
   * the field that answers "did the attachment actually change?" — see
   * `semanticAttachmentState` in insert-event.ts, which relies on its presence
   * to tell a re-publication apart from a genuine edit.
   */
  sha256: string;
}

interface StreamItemLike {
  id: string;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
}

/** Per-item record of audio attachments that the gateway should transcribe. */
interface AudioTranscriptionCandidate {
  artifactId: string;
  mimeType: string;
}

interface AudioTranscriptionJob extends AudioTranscriptionCandidate {
  /** Connection-scoped source identity of the persisted event. */
  originId: string;
  /** Exact stored version whose audio bytes produced this job. */
  baseEventId: number;
  /** Source identity is scoped to a connection, never only an organization. */
  connectionId: number;
  /** Persisted title included in the canonical event embedding text. */
  title: string | null;
}

function publicGatewayUrl(): string {
  return resolvePublicGatewayUrl();
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
  items: T[],
  bindingForItem?: (item: T) => string | undefined
): Promise<{
  items: T[];
  pendingTranscriptions: AudioTranscriptionCandidate[];
  publishedArtifactIds: string[];
}> {
  const coreServices = getLobuCoreServices();
  const artifactStore = coreServices?.getArtifactStore?.();
  if (!artifactStore) {
    return { items, pendingTranscriptions: [], publishedArtifactIds: [] };
  }

  const baseUrl = publicGatewayUrl();
  const pendingTranscriptions: AudioTranscriptionCandidate[] = [];
  const publishedArtifactIds: string[] = [];
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

      let published: Awaited<ReturnType<ArtifactStore["publish"]>>;
      try {
        published = await artifactStore.publish({
          buffer,
          filename,
          contentType: mime,
          publicGatewayUrl: baseUrl,
          binding: bindingForItem?.(item),
        });
        publishedArtifactIds.push(published.artifactId);
      } catch (error) {
        await Promise.allSettled(
          publishedArtifactIds.map((artifactId) => artifactStore.delete(artifactId))
        );
        throw error;
      }

      const materialized: MaterializedAttachment = {
        kind,
        filename: published.filename,
        mime_type: published.contentType,
        artifact_id: published.artifactId,
        download_url: published.downloadUrl,
        size_bytes: published.size,
        duration_ms: att.duration_ms ?? null,
        sha256: published.sha256,
      };
      rewritten.push(materialized);

      if (kind === "audio") {
        pendingTranscriptions.push({
          artifactId: published.artifactId,
          mimeType: published.contentType,
        });
      }
    }

    out.push({ ...item, attachments: rewritten });
  }

  return { items: out, pendingTranscriptions, publishedArtifactIds };
}

/** Materialize connector-style attachments returned by a device action. */
export async function materializeActionOutputAttachments(
  runId: number,
  actionOutput: Record<string, unknown>
): Promise<{
  output: Record<string, unknown>;
  publishedArtifactIds: string[];
}> {
  if (!Array.isArray(actionOutput.attachments)) {
    return { output: actionOutput, publishedArtifactIds: [] };
  }
  const { items, publishedArtifactIds } = await materializeInlineAttachments(
    [{ id: `action:${runId}`, attachments: actionOutput.attachments }],
    () => runArtifactBinding(runId)
  );
  return {
    output: { ...actionOutput, attachments: items[0]?.attachments ?? [] },
    publishedArtifactIds,
  };
}

export async function deleteMaterializedArtifacts(artifactIds: string[]): Promise<void> {
  if (artifactIds.length === 0) return;
  const coreServices = getLobuCoreServices();
  const artifactStore = coreServices?.getArtifactStore?.();
  if (!artifactStore) return;
  const results = await Promise.allSettled(
    artifactIds.map((artifactId) => artifactStore.delete(artifactId))
  );
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed > 0) {
    logger.warn(
      { artifact_count: artifactIds.length, failed },
      "[inline-attachments] failed to delete some uncommitted artifacts"
    );
  }
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
 * provider (OpenAI, or any OpenAI-compatible provider with a declared
 * `stt` block). If none exists, leaves the placeholder untouched —
 * graceful degradation.
 */
export function triggerAudioTranscriptions(
  organizationId: string,
  pending: AudioTranscriptionJob[]
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

export async function transcribeOne(
  job: AudioTranscriptionJob,
  organizationId: string,
  agentId: string
): Promise<void> {
  const coreServices = getLobuCoreServices();
  const artifactStore = coreServices!.getArtifactStore();
  const transcriptionService = coreServices!.getTranscriptionService();
  if (!artifactStore || !transcriptionService) return;

  const stored = await artifactStore.read(job.artifactId, {
    maxBytes: MAX_INLINE_ATTACHMENT_BYTES,
  });
  if (!stored) {
    logger.warn(
      { artifact_id: job.artifactId },
      "[inline-attachments] artifact missing — cannot transcribe"
    );
    return;
  }
  const result = await transcriptionService.transcribe(
    stored.bytes,
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

  let embedding: number[] | undefined;
  let embeddingModel: string | undefined;
  const env = getEnvFromProcess();
  if (env.EMBEDDINGS_SERVICE_URL?.trim()) {
    try {
      embeddingModel = getConfiguredEmbeddingModel();
      const embeddingText = [job.title, transcript].filter(Boolean).join(" ").trim();
      [embedding] = await generateEmbeddings([embeddingText], env, embeddingModel);
    } catch (err) {
      embedding = undefined;
      embeddingModel = undefined;
      logger.warn(
        { origin_id: job.originId, err: String(err) },
        "[inline-attachments] transcript embedding failed — backfill will retry"
      );
    }
  }

  const sql = getDb();
  await sql.begin(async (tx) => {
    // Use the same per-source lock as normal connector resync. The exact event
    // id ties this transcript to the bytes that produced it: if a newer resync
    // already replaced that version, its own transcription job owns the new
    // head and this stale result is discarded.
    await lockEventDedupIdentity(tx, job.connectionId, job.originId);
    const baseRows = (await tx`
      SELECT e.id, e.entity_ids, e.title, e.payload_type, e.payload_data,
             e.attachments, e.author_name, e.source_url, e.occurred_at,
             e.metadata, e.semantic_type, e.origin_type, e.score
      FROM events e
      WHERE e.id = ${job.baseEventId}
        AND e.organization_id = ${organizationId}
        AND e.connection_id = ${job.connectionId}
        AND e.origin_id = ${job.originId}
        AND NOT EXISTS (
          SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id
        )
      FOR UPDATE
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
      score: number | null;
    }>;
    const base = baseRows[0];
    if (!base) return;

    const meta = { ...(base.metadata ?? {}), transcript_provider: result.provider };

    // Content enrichment is the next stored version of the same source item.
    // Keeping origin_id stable lets the next connector resync find this head;
    // insertEvent inherits connector/feed/run/parent lineage from the base.
    await insertEvent(
      {
        entityIds: base.entity_ids ?? [],
        organizationId,
        originId: job.originId,
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
        score: base.score,
        embedding,
        embeddingModel,
        supersedesEventId: base.id,
      },
      {
        sql: tx,
        // This successor copies metadata from the already-persisted base row,
        // not from a connector payload. Keep the canonical tenant projections
        // that attribution stamped on that base so the current event head
        // remains recallable after transcription.
        trustedIdentityScopeProjections: true,
      }
    );
  });
}

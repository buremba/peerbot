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
import { createHash } from "node:crypto";
import { getDb } from "../db/client";
import {
  ArtifactStore,
  runArtifactBinding,
} from "../gateway/files/artifact-store";
import { getLobuCoreServices } from "../lobu/gateway";
import { insertEvent } from "./insert-event";
import logger from "./logger";
import { resolvePublicGatewayUrl } from "./public-origin";

/**
 * Hard cap on a single decoded attachment we'll publish. Server-side guard so
 * a compromised or buggy worker can't force unbounded memory + artifact-store
 * writes. Matches the Mac bridge's client-side 2MB cap for voice notes; if a
 * future connector legitimately needs to ship something larger, push it
 * through a multipart upload endpoint instead of inline base64.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_ATTACHMENT_BASE64_CHARS =
  Math.ceil((MAX_INLINE_ATTACHMENT_BYTES * 4) / 3) + 4;
const MAX_INLINE_ATTACHMENT_RAW_CHARS =
  MAX_INLINE_ATTACHMENT_BASE64_CHARS +
  Math.ceil(MAX_INLINE_ATTACHMENT_BASE64_CHARS / 64) * 2 +
  2;
const MAX_INLINE_ATTACHMENTS_PER_ITEM = 20;

function decodeInlineBase64(value: string): Buffer | null {
  if (value.length > MAX_INLINE_ATTACHMENT_RAW_CHARS) return null;
  // Validate the raw MIME-wrapped string in place. Buffer's base64 decoder
  // ignores ASCII framing whitespace, so avoiding value.replace() here saves a
  // second multi-megabyte string allocation on the request path.
  let encodedLength = 0;
  let padding = 0;
  let sawPadding = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      continue;
    }
    const isAlphabet =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (code === 0x3d) {
      sawPadding = true;
      padding += 1;
      if (padding > 2) return null;
    } else if (!isAlphabet || sawPadding) {
      return null;
    }
    encodedLength += 1;
  }
  if (
    encodedLength === 0 ||
    encodedLength > MAX_INLINE_ATTACHMENT_BASE64_CHARS ||
    encodedLength % 4 === 1 ||
    encodedLength - padding === 0
  ) {
    return null;
  }
  const buffer = Buffer.from(value, "base64");
  const canonical = buffer.toString("base64");
  const expectedLength =
    padding > 0 ? canonical.length : canonical.replace(/=+$/, "").length;
  if (expectedLength !== encodedLength || buffer.length === 0) return null;
  let canonicalIndex = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      continue;
    }
    if (value[index] !== canonical[canonicalIndex]) return null;
    canonicalIndex += 1;
  }
  return buffer;
}

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
  sha256: string;
  duration_ms?: number | null;
}

interface StreamItemLike {
  id: string;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
}

/**
 * Produce the bounded output that can safely serve as the durable
 * apply-succeeded marker before filesystem publication. Invalid inline
 * attachments are dropped exactly as they are during materialization; valid
 * MIME-wrapped inputs are stored in canonical base64 form so whitespace cannot
 * inflate runs.action_output.
 */
export function prepareActionOutputForDurableApply(
  actionOutput: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(actionOutput.attachments)) return actionOutput;
  if (actionOutput.attachments.length > MAX_INLINE_ATTACHMENTS_PER_ITEM) {
    logger.warn(
      {
        attachment_count: actionOutput.attachments.length,
        limit: MAX_INLINE_ATTACHMENTS_PER_ITEM,
      },
      "[inline-attachments] action output attachment count over the per-item limit — dropping the excess",
    );
  }
  const attachments: unknown[] = [];
  for (const raw of actionOutput.attachments.slice(
    0,
    MAX_INLINE_ATTACHMENTS_PER_ITEM,
  )) {
    if (!raw || typeof raw !== "object") {
      attachments.push(raw);
      continue;
    }
    const attachment = raw as InlineAttachment;
    if (!Object.hasOwn(attachment, "data")) {
      attachments.push(attachment);
      continue;
    }
    const decoded =
      typeof attachment.data === "string"
        ? decodeInlineBase64(attachment.data)
        : null;
    if (!decoded || decoded.length > MAX_INLINE_ATTACHMENT_BYTES) continue;
    attachments.push({ ...attachment, data: decoded.toString("base64") });
  }
  return { ...actionOutput, attachments };
}

/** Per-item record of audio attachments that the gateway should transcribe. */
interface AudioTranscriptionPending {
  originId: string;
  artifactId: string;
  filename: string;
  mimeType: string;
}

/** Publication failed and rollback could not remove every artifact it created. */
export class AttachmentMaterializationError extends AggregateError {
  constructor(
    errors: unknown[],
    readonly publishedArtifactIds: string[]
  ) {
    super(
      errors,
      `Attachment publication failed and partial artifact cleanup also failed: ${String(errors[1] ?? errors[0])}`
    );
    this.name = "AttachmentMaterializationError";
  }
}

/** An artifact rollback failed for these IDs. */
export class MaterializedArtifactCleanupError extends AggregateError {
  constructor(errors: unknown[], readonly artifactIds: string[]) {
    super(
      errors,
      `Failed to delete ${artifactIds.length} uncommitted artifact(s): ${String(errors[0])}`
    );
    this.name = "MaterializedArtifactCleanupError";
  }
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
  bindingForItem?: (item: T) => string | undefined,
  artifactStoreOverride?: Pick<ArtifactStore, "publish" | "delete">,
  options?: { preserveMaterializedHashes?: boolean },
): Promise<{
  items: T[];
  pendingTranscriptions: AudioTranscriptionPending[];
  publishedArtifactIds: string[];
}> {
  const coreServices = getLobuCoreServices();
  const artifactStore =
    artifactStoreOverride ??
    coreServices?.getArtifactStore?.() ??
    new ArtifactStore();

  const baseUrl = publicGatewayUrl();
  const pendingTranscriptions: AudioTranscriptionPending[] = [];
  const publishedArtifactIds: string[] = [];
  const out: T[] = [];

  for (const item of items) {
    const attachments = item.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) {
      out.push(item);
      continue;
    }

    if (attachments.length > MAX_INLINE_ATTACHMENTS_PER_ITEM) {
      logger.warn(
        {
          item_id: item.id,
          attachment_count: attachments.length,
          limit: MAX_INLINE_ATTACHMENTS_PER_ITEM,
        },
        "[inline-attachments] attachment count over the per-item limit — dropping the excess",
      );
    }

    const rewritten: unknown[] = [];
    for (const raw of attachments.slice(0, MAX_INLINE_ATTACHMENTS_PER_ITEM)) {
      if (!raw || typeof raw !== "object") {
        rewritten.push(raw);
        continue;
      }
      const att = raw as InlineAttachment;
      if (!Object.hasOwn(att, "data")) {
        if (options?.preserveMaterializedHashes) {
          rewritten.push(att);
        } else {
          // sha256 is server-authored integrity metadata for bytes published
          // above. A connector-supplied reference is not allowed to forge it
          // and influence event unchanged detection.
          const { sha256: _untrustedSha256, ...reference } = att;
          rewritten.push(reference);
        }
        continue;
      }
      const filename = att.filename || "attachment";
      const mime = att.mime_type || "application/octet-stream";
      const kind = att.kind || inferKindFromMime(mime);
      const buffer =
        typeof att.data === "string" ? decodeInlineBase64(att.data) : null;
      if (!buffer) {
        logger.warn(
          { item_id: item.id },
          "[inline-attachments] invalid or oversized base64 — dropping attachment",
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
          "[inline-attachments] attachment exceeds server cap — dropping attachment",
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
        try {
          await deleteMaterializedArtifacts(
            publishedArtifactIds,
            artifactStore,
          );
        } catch (cleanupError) {
          throw new AttachmentMaterializationError(
            [error, cleanupError],
            cleanupError instanceof MaterializedArtifactCleanupError
              ? cleanupError.artifactIds
              : [...publishedArtifactIds],
          );
        }
        throw error;
      }

      const materialized: MaterializedAttachment = {
        kind,
        filename: published.filename,
        mime_type: published.contentType,
        artifact_id: published.artifactId,
        download_url: published.downloadUrl,
        size_bytes: published.size,
        sha256: createHash("sha256").update(buffer).digest("hex"),
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

  return { items: out, pendingTranscriptions, publishedArtifactIds };
}

/** Materialize connector-style attachments returned by a device action. */
export async function materializeActionOutputAttachments(
  runId: number,
  actionOutput: Record<string, unknown>,
  artifactStoreOverride?: Pick<ArtifactStore, "publish" | "delete">,
): Promise<{
  output: Record<string, unknown>;
  publishedArtifactIds: string[];
}> {
  if (!Array.isArray(actionOutput.attachments)) {
    return { output: actionOutput, publishedArtifactIds: [] };
  }
  const { items, publishedArtifactIds } = await materializeInlineAttachments(
    [{ id: `action:${runId}`, attachments: actionOutput.attachments }],
    () => runArtifactBinding(runId),
    artifactStoreOverride,
    { preserveMaterializedHashes: true },
  );
  return {
    output: { ...actionOutput, attachments: items[0]?.attachments ?? [] },
    publishedArtifactIds,
  };
}

export async function deleteMaterializedArtifacts(
  artifactIds: string[],
  artifactStoreOverride?: Pick<ArtifactStore, "delete">,
): Promise<void> {
  if (artifactIds.length === 0) return;
  const coreServices = getLobuCoreServices();
  const artifactStore =
    artifactStoreOverride ??
    coreServices?.getArtifactStore?.() ??
    new ArtifactStore();
  const results = await Promise.allSettled(
    artifactIds.map((artifactId) => artifactStore.delete(artifactId)),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ artifactId: artifactIds[index]!, reason: result.reason }]
      : [],
  );
  if (failures.length > 0) {
    throw new MaterializedArtifactCleanupError(
      failures.map((failure) => failure.reason),
      failures.map((failure) => failure.artifactId),
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
  pending: AudioTranscriptionPending[],
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
          "[inline-attachments] transcription skipped — coreServices unavailable",
        );
        return;
      }

      const agentId = await pickTranscriptionAgent(organizationId);
      if (!agentId) {
        logger.info(
          { organizationId, pending: pending.length },
          "[inline-attachments] no STT-capable agent in org — leaving voice-note placeholders",
        );
        return;
      }

      for (const job of pending) {
        try {
          await transcribeOne(job, organizationId, agentId);
        } catch (err) {
          logger.warn(
            { origin_id: job.originId, err: String(err) },
            "[inline-attachments] transcription job failed",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { organizationId, err: String(err) },
        "[inline-attachments] transcription orchestrator threw",
      );
    }
  })();
}

async function pickTranscriptionAgent(
  organizationId: string,
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
  agentId: string,
): Promise<void> {
  const coreServices = getLobuCoreServices();
  const artifactStore = coreServices!.getArtifactStore();
  const transcriptionService = coreServices!.getTranscriptionService();
  if (!artifactStore || !transcriptionService) return;

  const stored = await artifactStore.read(job.artifactId);
  if (!stored) {
    logger.warn(
      { artifact_id: job.artifactId },
      "[inline-attachments] artifact missing — cannot transcribe",
    );
    return;
  }
  const result = await transcriptionService.transcribe(
    stored.bytes,
    agentId,
    job.mimeType,
  );
  if ("error" in result) {
    logger.info(
      { origin_id: job.originId, error: result.error },
      "[inline-attachments] transcription returned error — keeping placeholder",
    );
    return;
  }

  const transcript = result.text.trim();
  if (!transcript) return;

  const sql = getDb();
  const baseRows = (await sql`
    SELECT id, entity_ids, title, payload_type, payload_data, attachments,
           author_name, source_url, occurred_at, metadata, semantic_type,
           origin_type, score
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
    score: number | null;
  }>;
  const base = baseRows[0];
  if (!base) return;

  const meta = {
    ...(base.metadata ?? {}),
    transcript_provider: result.provider,
  };

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
    score: base.score,
    supersedesEventId: base.id,
  });
}

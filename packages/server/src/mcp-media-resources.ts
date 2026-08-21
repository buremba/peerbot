import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ArtifactStore,
  eventArtifactBinding,
  runArtifactBinding,
} from './gateway/files/artifact-store';
import type { Env } from './index';
import { getLobuCoreServices } from './lobu/gateway';
import { type AuthContext, executeTool } from './tools/execute';

// resources/read embeds base64 in one JSON-RPC response, so keep the decoded
// cap bounded below the point where concurrent reads amplify app memory.
const MAX_MCP_RESOURCE_BYTES = 5 * 1024 * 1024;

type ResourceLink = Extract<
  CallToolResult['content'][number],
  { type: 'resource_link' }
>;

type AttachmentRecord = {
  artifact_id?: unknown;
  filename?: unknown;
  mime_type?: unknown;
  size_bytes?: unknown;
};

type ResourceRef =
  | { kind: 'run'; id: number; index: number }
  | { kind: 'event'; id: number; index: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function runAttachmentResourceUri(runId: number, index: number): string {
  return `lobu://run/${runId}/attachment/${index}`;
}

function eventAttachmentResourceUri(eventId: number, index: number): string {
  return `lobu://event/${eventId}/attachment/${index}`;
}

function resourceLinksForAttachments(
  uriForIndex: (index: number) => string,
  attachments: unknown
): ResourceLink[] {
  if (!Array.isArray(attachments)) return [];

  return attachments.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const attachment = raw as AttachmentRecord;
    if (
      typeof attachment.artifact_id !== 'string' ||
      typeof attachment.mime_type !== 'string'
    ) {
      return [];
    }
    const name =
      typeof attachment.filename === 'string' && attachment.filename.trim()
        ? attachment.filename
        : `attachment-${index + 1}`;
    const size = nonNegativeInteger(attachment.size_bytes);
    return [
      {
        type: 'resource_link' as const,
        uri: uriForIndex(index),
        name,
        mimeType: attachment.mime_type,
        ...(size !== null ? { size } : {}),
      },
    ];
  });
}

function resourceLinksForRunOutput(runId: number, output: unknown): ResourceLink[] {
  if (!isRecord(output)) return [];
  return resourceLinksForAttachments(
    (index) => runAttachmentResourceUri(runId, index),
    output.attachments
  );
}

function resourceLinksForKnowledgeRead(value: Record<string, unknown>): ResourceLink[] {
  if (!Array.isArray(value.content)) return [];

  return value.content.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const eventId = positiveInteger(raw.id);
    if (eventId === null) return [];
    return resourceLinksForAttachments(
      (index) => eventAttachmentResourceUri(eventId, index),
      raw.attachments
    );
  });
}

/**
 * Recognize resource-bearing ClientSDK return values and expose materialized
 * attachments as MCP resource links. Links use Lobu-owned stable ids, never
 * ephemeral signed download URLs.
 */
function mcpResourceLinksForSdkReturnValue(value: unknown): ResourceLink[] {
  if (!isRecord(value)) return [];

  if (value.action === 'execute' && value.status === 'completed') {
    const runId = positiveInteger(value.run_id);
    return runId === null ? [] : resourceLinksForRunOutput(runId, value.output);
  }

  if (value.action === 'get_run' && isRecord(value.run)) {
    const runId = positiveInteger(value.run.id);
    return runId === null
      ? []
      : resourceLinksForRunOutput(runId, value.run.output);
  }

  return resourceLinksForKnowledgeRead(value);
}

/**
 * Add media links at the MCP boundary, after the tool result has already been
 * reduced to its public shape. This keeps host-only content out of tool
 * handlers, audit payloads, structuredContent, and output schemas.
 */
export function mcpResourceLinksForToolResult(
  toolName: string,
  publicResult: unknown
): ResourceLink[] {
  if (!isRecord(publicResult)) return [];

  if (toolName === 'run_sdk' || toolName === 'query_sdk') {
    return mcpResourceLinksForSdkReturnValue(publicResult.return_value);
  }

  if (toolName === 'save_memory') {
    const eventId = positiveInteger(publicResult.id);
    return eventId === null
      ? []
      : resourceLinksForAttachments(
          (index) => eventAttachmentResourceUri(eventId, index),
          publicResult.attachments
        );
  }

  return toolName === 'read_knowledge'
    ? resourceLinksForKnowledgeRead(publicResult)
    : [];
}

function parseAttachmentUri(uri: string): ResourceRef | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'lobu:') return null;
  const kind = parsed.hostname;
  if (kind !== 'run' && kind !== 'event') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[1] !== 'attachment') return null;
  const id = Number(parts[0]);
  const index = Number(parts[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return { kind, id, index };
}

async function loadResourceAttachment(
  ref: ResourceRef,
  env: Env,
  authCtx: AuthContext
): Promise<{ attachment: Record<string, unknown>; binding: string } | null> {
  if (ref.kind === 'run') {
    const result = await executeTool(
      'manage_operations',
      { action: 'get_run', run_id: ref.id },
      env,
      authCtx
    );
    if (!isRecord(result) || result.action !== 'get_run' || !isRecord(result.run)) {
      return null;
    }
    const output = result.run.output;
    if (!isRecord(output) || !Array.isArray(output.attachments)) return null;
    const raw = output.attachments[ref.index];
    return isRecord(raw)
      ? { attachment: raw, binding: runArtifactBinding(ref.id) }
      : null;
  }

  // One requested id can resolve to several lineage rows, so read with
  // headroom rather than limit: 1 and pick the exact version below.
  const result = await executeTool(
    'read_knowledge',
    { content_ids: [ref.id], limit: 50 },
    env,
    authCtx
  );
  if (!isRecord(result) || !Array.isArray(result.content)) return null;
  const item = result.content.find(
    (raw) => isRecord(raw) && positiveInteger(raw.id) === ref.id
  );
  if (!isRecord(item) || !Array.isArray(item.attachments)) return null;
  const raw = item.attachments[ref.index];
  const originId = item.origin_id;
  if (!isRecord(raw) || !authCtx.organizationId) return null;
  // read_knowledge renders a NULL origin_id as '', which cannot reproduce the
  // binding the artifact was published under.
  if (typeof originId !== 'string' || !originId) return null;
  return {
    attachment: raw,
    binding: eventArtifactBinding({
      organizationId: authCtx.organizationId,
      connectionId: positiveInteger(item.connection_id),
      feedId: positiveInteger(item.feed_id),
      originId,
    }),
  };
}

/**
 * Resolve a stable Lobu attachment URI through the same permission-aware
 * readers used by SDK/MCP tools, then return its bytes as an MCP blob.
 */
export async function readMcpAttachmentResource(
  uri: string,
  env: Env,
  authCtx: AuthContext
): Promise<
  | {
      contents: Array<{
        uri: string;
        mimeType: string;
        blob: string;
      }>;
    }
  | null
> {
  const ref = parseAttachmentUri(uri);
  if (!ref) return null;

  const loaded = await loadResourceAttachment(ref, env, authCtx);
  if (!loaded || typeof loaded.attachment.artifact_id !== 'string') {
    throw new Error(`Unknown resource: ${uri}`);
  }

  // Reuse the gateway's configured artifact store. The fallback is for
  // isolated tests that call this module without booting core services.
  const artifactStore =
    getLobuCoreServices()?.getArtifactStore() ?? new ArtifactStore();
  const metadata = await artifactStore.inspect(
    loaded.attachment.artifact_id,
    { binding: loaded.binding },
  );
  if (!metadata) throw new Error(`Unknown resource: ${uri}`);
  if (metadata.size > MAX_MCP_RESOURCE_BYTES) {
    throw new Error(
      `MCP resource is too large to inline (${metadata.size} bytes; limit ${MAX_MCP_RESOURCE_BYTES})`,
    );
  }
  const stored = await artifactStore.read(loaded.attachment.artifact_id, {
    binding: loaded.binding,
    maxBytes: MAX_MCP_RESOURCE_BYTES,
  });
  if (!stored) throw new Error(`Unknown resource: ${uri}`);
  return {
    contents: [
      {
        uri,
        mimeType: stored.metadata.contentType,
        blob: stored.bytes.toString('base64'),
      },
    ],
  };
}

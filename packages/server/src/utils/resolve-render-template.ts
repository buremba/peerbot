/**
 * Resolve an event's render template + bound data from its event kind.
 *
 * `resolveEntityRender`'s contract is that "every render surface reuses this so
 * a type renders identically everywhere" (default-entity-template.ts). This is
 * that resolution, lifted out of `get_content`'s render tail so the surfaces
 * genuinely share one implementation instead of each re-deriving it: the web /
 * MCP read path (`get_content`) and chat notification delivery both call this.
 *
 * Returns null when the event should keep whatever rendering it already has —
 * no kind, no resolvable template, or (for a non-notification) no metadata to
 * bind. Callers treat null as "leave it alone".
 */
import { resolveEntityRender } from './default-entity-template';
import { resolveEventKindDefinition } from './event-kind-validation';

export interface ResolvedRenderTemplate {
  /** The template root node, to be wrapped as `{ root }` by the caller. */
  root: Record<string, unknown>;
  /** The data the template's `data` bindings resolve against. */
  data: Record<string, unknown>;
}

export async function resolveRenderTemplate(params: {
  semanticType: string | null | undefined;
  organizationId: string;
  /**
   * True for notification events (identified by `metadata.notification_type`).
   * A notification binds its `payload_data` and resolves its kind without entity
   * scoping — its routing metadata is deliberately kept out of the render data.
   */
  isNotification: boolean;
  /** `payload_data` for a notification; `metadata` otherwise. */
  renderData: Record<string, unknown> | null | undefined;
  entityIds?: number[] | null;
}): Promise<ResolvedRenderTemplate | null> {
  const { semanticType, organizationId, isNotification, renderData } = params;
  if (!semanticType) return null;

  const data = isNotification ? (renderData ?? {}) : renderData;
  if (!isNotification && (!data || Object.keys(data).length === 0)) return null;

  const kind = await resolveEventKindDefinition(
    semanticType,
    organizationId,
    isNotification ? undefined : (params.entityIds ?? undefined)
  );
  if (!kind) return null;

  const root = resolveEntityRender(kind.jsonTemplate, kind.metadataSchema);
  if (!root) return null;

  return { root, data: data ?? {} };
}

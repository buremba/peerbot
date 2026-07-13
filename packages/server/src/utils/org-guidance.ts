/**
 * Org-wide guidance: admin-authored context injected into every agent prompt.
 *
 * `guidance` is a built-in, code-level event kind (not declared in any
 * entity type's `event_kinds` registry): current, non-superseded `guidance`
 * events for an org render as an "Organization Context" section via the single
 * site `buildWorkspaceInstructions`. That block is the lobu-memory MCP server's
 * instructions, which reach BOTH surfaces from one render: the MCP client
 * directly, and the agent-worker prompt (the worker folds MCP server
 * instructions into its context). It is deliberately NOT re-injected in
 * InstructionService — that would duplicate it in the worker prompt.
 *
 * Design notes:
 * - Anchoring: injection selects by organization_id + semantic_type only. A
 *   guidance event may carry entity anchors, but entity-scoped delivery is a
 *   later refinement (the kind's eventual registry home is a `$org` singleton
 *   type, not built). Type/field context is out of scope here — it lives in the
 *   entity-type/relationship/field `description` columns the renderer surfaces.
 * - Security: this lands in EVERY agent's system prompt, so both authorship and
 *   removal are owner/admin-gated (assertCanAuthorGuidance /
 *   assertCanRemoveGuidance — the latter covers supersede + delete, which mask
 *   guidance via superseded_by). Rows with a connection_id OR connector_key are
 *   excluded (provenance fence) so no connector/webhook can smuggle in org-wide
 *   text — connection_id alone is not proof of admin authorship.
 * - Cache doctrine: part of the cached system prompt, mutating only on explicit
 *   admin edit, so it counts as stable data. Rendering is deterministic: stable
 *   order (event id ASC), no timestamps/counts, hard char cap + row cap with
 *   deterministic truncation markers.
 */

import { getDb, pgBigintArray } from '../db/client';
import { ToolUserError } from './errors';

export const GUIDANCE_SEMANTIC_TYPE = 'guidance';

/** A member role that may author or mutate org-wide guidance. */
function isGuidanceAuthor(memberRole: string | null | undefined): boolean {
  return memberRole === 'owner' || memberRole === 'admin';
}

/**
 * Fail closed if a non-owner/admin tries to author `guidance`. Authoring
 * lands text in EVERY agent's system prompt — a prompt-injection surface.
 */
export function assertCanAuthorGuidance(
  semanticType: string,
  memberRole: string | null | undefined
): void {
  if (semanticType === GUIDANCE_SEMANTIC_TYPE && !isGuidanceAuthor(memberRole)) {
    throw new ToolUserError(
      `semantic_type '${GUIDANCE_SEMANTIC_TYPE}' is organization-wide context injected into every agent's prompt; only organization owners/admins can save it.`,
      403
    );
  }
}

/**
 * Fail closed if a non-owner/admin tries to REMOVE org guidance from prompts by
 * superseding/tombstoning it. Guidance is masked by `superseded_by`, so any
 * write that stamps that edge on a guidance target — a supersede with a
 * different (permitted) kind, or a delete_knowledge tombstone — would silently
 * erase admin context from every agent. Authorship is admin-gated; removal must
 * be too. `targetIds` are event ids whose superseded_by this op would stamp.
 */
export async function assertCanRemoveGuidance(
  organizationId: string,
  targetIds: number[],
  memberRole: string | null | undefined
): Promise<void> {
  if (targetIds.length === 0 || isGuidanceAuthor(memberRole)) return;
  const sql = getDb();
  const guarded = await sql<{ id: number }>`
    SELECT id FROM events
    WHERE id = ANY(${pgBigintArray(targetIds)}::bigint[])
      AND organization_id = ${organizationId}
      AND semantic_type = ${GUIDANCE_SEMANTIC_TYPE}
    LIMIT 1
  `;
  if (guarded.length > 0) {
    throw new ToolUserError(
      `Cannot supersede or delete organization-wide '${GUIDANCE_SEMANTIC_TYPE}' context; only organization owners/admins can change it.`,
      403
    );
  }
}

/** Hard cap on total injected guidance characters (per org, per prompt). */
export const ORG_GUIDANCE_CHAR_BUDGET = 3000;

export const ORG_GUIDANCE_TRUNCATION_MARKER =
  '\n[additional organization context truncated — consolidate guidance events]';

/** Row-count bound so the query stays cheap; the char budget governs output. */
const ORG_GUIDANCE_ROW_LIMIT = 100;

/**
 * Render the current org guidance as a prompt-ready text block (no heading),
 * or null when the org has none. Deterministic for a given events state.
 */
export async function loadOrgGuidanceBlock(organizationId: string): Promise<string | null> {
  const sql = getDb();

  // Read the canonical masking view (superseded_by IS NULL) rather than
  // re-implementing the anti-join — same tombstone parity as query_sql. The
  // view exposes id/title/payload_text/organization_id/semantic_type/
  // connection_id/connector_key, so the guidance filters apply unchanged.
  // Fetch one row past the cap so we can mark (not silently drop) an
  // over-limit org's tail.
  //
  // Provenance fence: only admin-authored rows may render. save_content leaves
  // both connection_id AND connector_key NULL; every connector/webhook path
  // stamps at least one — a webhook writes connector_key='webhook:<id>' with a
  // NULL connection_id (webhook-ingest.ts) and its semantic_type is
  // caller-configurable, so `connection_id IS NULL` alone is NOT proof of admin
  // authorship. Require BOTH to be NULL, or a webhook token holder could inject
  // arbitrary text into every agent's system prompt by labeling deliveries
  // `guidance`.
  const rows = await sql`
    SELECT e.id, e.title, e.payload_text
    FROM current_event_records e
    WHERE e.organization_id = ${organizationId}
      AND e.semantic_type = ${GUIDANCE_SEMANTIC_TYPE}
      AND e.connection_id IS NULL
      AND e.connector_key IS NULL
      AND e.payload_text IS NOT NULL
    ORDER BY e.id ASC
    LIMIT ${ORG_GUIDANCE_ROW_LIMIT + 1}
  `;

  if (rows.length === 0) return null;

  const rowsOmittedByCount = rows.length > ORG_GUIDANCE_ROW_LIMIT;
  const capped = rowsOmittedByCount ? rows.slice(0, ORG_GUIDANCE_ROW_LIMIT) : rows;

  const blocks: string[] = [];
  for (const row of capped) {
    const text = String(row.payload_text).trim();
    if (!text) continue;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    blocks.push(title ? `**${title}**\n${text}` : text);
  }
  if (blocks.length === 0) return null;

  const body = blocks.join('\n\n');

  // Truncate so the FINAL block (body + marker) stays within the declared cap —
  // reserve the marker's length before slicing rather than appending past it.
  // A single marker signals omission from either cause (char budget OR row cap).
  const overBudget = body.length > ORG_GUIDANCE_CHAR_BUDGET;
  if (overBudget || rowsOmittedByCount) {
    const keep = ORG_GUIDANCE_CHAR_BUDGET - ORG_GUIDANCE_TRUNCATION_MARKER.length;
    const head = overBudget ? body.slice(0, Math.max(0, keep)) : body;
    return head + ORG_GUIDANCE_TRUNCATION_MARKER;
  }
  return body;
}

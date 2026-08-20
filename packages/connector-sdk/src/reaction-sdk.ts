/**
 * Reaction context types.
 *
 * The runtime SDK reaction scripts call is `ClientSDK` (defined in
 * `packages/server/src/sandbox/client-sdk.ts`); only the context
 * shape is shared across packages, so only those types live here.
 */

export interface ReactionEntity {
  id: number;
  name: string;
  entity_type: string;
  metadata: Record<string, unknown>;
}

/**
 * Context passed to reaction scripts containing the analysis results
 * and metadata about the completed Automation run. Reaction scripts have the
 * shape `default async (ctx: ReactionContext, client, params?)`.
 */
export interface ReactionContext {
  /** The extracted analysis data from the completed run */
  extracted_data: Record<string, unknown>;
  /** All entities the Automation is attached to */
  entities: ReactionEntity[];
  /** The completed run and its analyzed period */
  window: {
    run_id: number;
    automation_id: number;
    window_start: string;
    window_end: string;
    granularity: string;
    content_analyzed: number;
  };
  /** Automation identity */
  automation: {
    id: number;
    slug: string;
    name: string;
    version: number;
  };
  /** Organization context */
  organization_id: string;
  /** Stable workspace slug for relative app permalinks. */
  organization_slug: string;
}

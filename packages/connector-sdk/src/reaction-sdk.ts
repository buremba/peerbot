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
 * and metadata about the watcher window. Reaction scripts have the
 * shape `default async (ctx: ReactionContext, client, params?)`.
 */
export interface ReactionContext {
  /** The extracted analysis data from the completed window */
  extracted_data: Record<string, unknown>;
  /** All entities the watcher is attached to */
  entities: ReactionEntity[];
  /** The window that was just completed */
  window: {
    id: number;
    watcher_id: number;
    window_start: string;
    window_end: string;
    granularity: string;
    content_analyzed: number;
  };
  /** Watcher identity */
  watcher: {
    id: number;
    slug: string;
    name: string;
    version: number;
  };
  /** Organization context */
  organization_id: string;
}

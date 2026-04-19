/**
 * Reaction SDK Types
 *
 * Type definitions for watcher reaction scripts. These scripts run automatically
 * after a watcher window completes, allowing watchers to take actions based on
 * their analysis results.
 */

export interface ReactionEntity {
  id: number;
  name: string;
  entity_type: string;
  metadata: Record<string, unknown>;
}

/**
 * Context passed to reaction scripts containing the analysis results
 * and metadata about the watcher window.
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

/**
 * SDK provided to reaction scripts for interacting with the system.
 * All operations are tracked in watcher_reactions for attribution.
 */
export interface ReactionSDK {
  entities: {
    /** Get an entity by ID */
    get(id: number): Promise<ReactionEntity | null>;

    /** Create a new entity */
    create(params: {
      type: string;
      name: string;
      metadata?: Record<string, unknown>;
    }): Promise<{ id: number; slug: string }>;

    /** Update an existing entity */
    update(params: {
      entity_id: number;
      name?: string;
      metadata?: Record<string, unknown>;
    }): Promise<void>;

    /** Create a relationship between two entities */
    link(
      fromId: number,
      toId: number,
      relationshipType: string,
      metadata?: Record<string, unknown>
    ): Promise<void>;

    /** Search for entities by name */
    search(
      query: string,
      options?: { limit?: number }
    ): Promise<Array<{ id: number; name: string; type: string }>>;
  };

  actions: {
    /** Execute a connection operation (e.g., create issue, send email) */
    execute(
      connectionId: number,
      operationKey: string,
      input: Record<string, unknown>
    ): Promise<{ run_id: number; output: Record<string, unknown> }>;

    /** List available operations from entity's connections */
    listAvailable(): Promise<
      Array<{
        connection_id: number;
        operation_key: string;
        name: string;
        kind: 'read' | 'write';
        requires_approval: boolean;
      }>
    >;
  };

  content: {
    /** Save content to an entity */
    save(entityId: number, content: string, semanticType?: string): Promise<void>;
  };

  /** Send a notification to organization members */
  notify(
    title: string,
    body: string,
    options?: { resource_url?: string; connection_id?: string }
  ): Promise<void>;

  /** Run a read-only parameterized SQL query */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;

  /** Structured logging (tracked in watcher_reactions) */
  log(message: string, data?: Record<string, unknown>): void;
}

/**
 * The main export that reaction scripts must implement.
 */
export type ReactionHandler = (ctx: ReactionContext, sdk: ReactionSDK) => Promise<void>;

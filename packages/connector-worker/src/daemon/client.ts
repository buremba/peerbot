/**
 * Worker API Client
 *
 * HTTP client for communicating with the backend worker API endpoints.
 * Updated for V1 integration platform: runs-based job model.
 */

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return end === value.length ? value : value.slice(0, end);
}

// ============================================
// ExecutorClient Interface
// ============================================

/**
 * Interface for job execution clients.
 * Implemented by WorkerClient (HTTP).
 * Allows the executor to work without coupling to a specific transport.
 */
export interface ExecutorClient {
  readonly id: string;
  poll(): Promise<PollResponse>;
  heartbeat(
    runId: number,
    progress?: {
      items_collected_so_far?: number;
      current_page?: number;
      elapsed_ms?: number;
    }
  ): Promise<void>;
  stream(batch: StreamBatch): Promise<void>;
  complete(req: CompleteRequest): Promise<void>;
  completeAction(req: CompleteActionRequest): Promise<void>;
  fetchEventsForEmbedding(eventIds: number[]): Promise<EmbedEvent[]>;
  completeEmbeddings(req: CompleteEmbeddingsRequest): Promise<void>;
  emitAuthArtifact(req: EmitAuthArtifactRequest): Promise<void>;
  pollAuthSignal(req: PollAuthSignalRequest): Promise<PollAuthSignalResponse>;
  completeAuth(req: CompleteAuthRequest): Promise<void>;
}

// ============================================
// Types
// ============================================

export interface WorkerCapabilities {
  browser: boolean;
}

export interface OAuthCredentials {
  accessToken: string;
  provider: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scope?: string | null;
}

export interface PollResponse {
  next_poll_seconds?: number;
  /** Run ID (replaces execution_id) */
  run_id?: number;
  /** Run type: 'sync', 'action', 'watcher', 'embed_backfill', or 'auth' */
  run_type?: 'sync' | 'action' | 'watcher' | 'embed_backfill' | 'auth';
  /** Auth profile ID (for auth runs) */
  auth_profile_id?: number;
  /** Previous credentials on the auth profile (for re-auth flows) */
  previous_credentials?: Record<string, unknown> | null;
  /** Connector key, e.g. 'google.gmail' */
  connector_key?: string;
  /** Feed key for sync runs, e.g. 'threads' */
  feed_key?: string;
  /** Feed config */
  config?: Record<string, unknown>;
  /** Feed checkpoint */
  checkpoint?: Record<string, unknown>;
  /** Entity IDs from feed */
  entity_ids?: number[];
  /** OAuth credentials */
  credentials?: OAuthCredentials | null;
  /** Stored env_keys credentials from DB */
  connection_credentials?: Record<string, unknown>;
  /** Connection ID */
  connection_id?: number;
  /** Feed ID (for sync runs) */
  feed_id?: number;
  /** Compiled connector code */
  compiled_code?: string;
  /** Connection session state (browser cookies, etc.) */
  session_state?: Record<string, unknown>;
  /** Connector version */
  connector_version?: string;
  /** Action key (for action runs) */
  action_key?: string;
  /** Action input (for action runs) */
  action_input?: Record<string, unknown>;
  /** Watcher ID (for watcher runs) */
  watcher_id?: number;
  /** Window ID (for watcher runs) */
  window_id?: number;
  /** Compiled reaction script (for watcher runs) */
  reaction_script_compiled?: string;
  /** Extracted data from the completed window (for watcher runs) */
  extracted_data?: Record<string, unknown>;
  /** Entity info (for watcher runs) */
  entity?: { id: number; name: string; entity_type: string; metadata: Record<string, unknown> };
  /** Window metadata (for watcher runs) */
  window_start?: string;
  window_end?: string;
  granularity?: string;
  content_analyzed?: number;
  /** Organization ID (for watcher runs) */
  organization_id?: string;
}

export interface ContentItem {
  id: string;
  title?: string;
  payload_text: string;
  author_name?: string;
  occurred_at: string;
  source_url?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  origin_parent_id?: string;
  embedding?: number[];
  origin_type?: string;
  semantic_type?: string;
}

export interface StreamBatch {
  type: 'batch';
  run_id: number;
  items: ContentItem[];
  checkpoint?: Record<string, unknown>;
}

export interface CompleteRequest {
  run_id: number;
  worker_id: string;
  status: 'success' | 'failed';
  items_collected?: number;
  error_message?: string;
  checkpoint?: Record<string, unknown>;
  auth_update?: Record<string, unknown>;
  /** Tail of subprocess stdout+stderr (already redacted in the worker). */
  output_tail?: string;
  /** Subprocess exit code, if the child terminated without an IPC result. */
  exit_code?: number | null;
  /** Subprocess exit signal, if any. */
  exit_signal?: string | null;
  /** Categorized exit reason: ok | error_message | timeout | oom | crash. */
  exit_reason?: 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';
}

export interface CompleteActionRequest {
  run_id: number;
  worker_id: string;
  status: 'success' | 'failed';
  action_output?: Record<string, unknown>;
  error_message?: string;
}

export interface EmbedEvent {
  id: number;
  content: string;
  title: string | null;
}

export interface CompleteEmbeddingsRequest {
  run_id: number;
  worker_id: string;
  embeddings: Array<{ event_id: number; embedding: number[] }>;
  error_message?: string;
}

export interface EmitAuthArtifactRequest {
  run_id: number;
  worker_id: string;
  artifact: Record<string, unknown>;
}

export interface PollAuthSignalRequest {
  run_id: number;
  worker_id: string;
  signal_name: string;
}

export interface PollAuthSignalResponse {
  signal?: Record<string, unknown>;
}

export interface CompleteAuthRequest {
  run_id: number;
  worker_id: string;
  status: 'success' | 'failed';
  credentials?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error_message?: string;
  /** Tail of subprocess stdout+stderr (already redacted in the worker). */
  output_tail?: string;
  /** Subprocess exit code, if the child terminated without an IPC result. */
  exit_code?: number | null;
  /** Subprocess exit signal, if any. */
  exit_signal?: string | null;
  /** Categorized exit reason: ok | error_message | timeout | oom | crash. */
  exit_reason?: 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';
}

/**
 * Worker API Client
 */
export class WorkerClient implements ExecutorClient {
  private apiUrl: string;
  private workerId: string;
  private capabilities: WorkerCapabilities;
  private authToken?: string;
  private version: string;

  constructor(config: {
    apiUrl: string;
    workerId: string;
    authToken?: string;
    capabilities: WorkerCapabilities;
    version?: string;
  }) {
    this.apiUrl = trimTrailingSlashes(config.apiUrl);
    this.workerId = config.workerId;
    this.capabilities = config.capabilities;
    this.authToken = config.authToken?.trim() || undefined;
    this.version = config.version ?? '1.0.0';
  }

  private authHeaders(): Record<string, string> {
    if (!this.authToken) return {};
    return { Authorization: `Bearer ${this.authToken}` };
  }

  private async requestJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`${path} failed: ${response.status} ${response.statusText} ${responseText}`);
    }

    return response.json() as Promise<T>;
  }

  private async requestVoid(path: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`${path} failed: ${response.status} ${response.statusText} ${responseText}`);
    }
  }

  /**
   * Poll for available runs
   */
  async poll(): Promise<PollResponse> {
    return this.requestJson<PollResponse>('/api/workers/poll', {
      worker_id: this.workerId,
      capabilities: this.capabilities,
      version: this.version,
    });
  }

  /**
   * Send heartbeat for active run
   */
  async heartbeat(
    runId: number,
    progress?: {
      items_collected_so_far?: number;
      current_page?: number;
      elapsed_ms?: number;
    }
  ): Promise<void> {
    await this.requestVoid('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: this.workerId,
      progress,
    });
  }

  /**
   * Stream content batch to backend
   */
  async stream(batch: StreamBatch): Promise<void> {
    await this.requestVoid('/api/workers/stream', batch as unknown as Record<string, unknown>);
  }

  /**
   * Report sync run completion
   */
  async complete(req: CompleteRequest): Promise<void> {
    await this.requestVoid('/api/workers/complete', req as unknown as Record<string, unknown>);
  }

  /**
   * Report action run completion
   */
  async completeAction(req: CompleteActionRequest): Promise<void> {
    await this.requestVoid(
      '/api/workers/complete-action',
      req as unknown as Record<string, unknown>
    );
  }

  /**
   * Fetch events needing embeddings
   */
  async fetchEventsForEmbedding(eventIds: number[]): Promise<EmbedEvent[]> {
    const result = await this.requestJson<{ events: EmbedEvent[] }>('/api/workers/fetch-events', {
      event_ids: eventIds,
    });
    return result.events;
  }

  /**
   * Submit generated embeddings
   */
  async completeEmbeddings(req: CompleteEmbeddingsRequest): Promise<void> {
    await this.requestVoid(
      '/api/workers/complete-embeddings',
      req as unknown as Record<string, unknown>
    );
  }

  /**
   * Emit an auth artifact (QR, redirect URL, prompt) for the UI to render.
   */
  async emitAuthArtifact(req: EmitAuthArtifactRequest): Promise<void> {
    await this.requestVoid(
      '/api/workers/emit-auth-artifact',
      req as unknown as Record<string, unknown>
    );
  }

  /**
   * Poll for a signal sent by the UI (OAuth callback, form submit, cancel).
   */
  async pollAuthSignal(req: PollAuthSignalRequest): Promise<PollAuthSignalResponse> {
    return this.requestJson<PollAuthSignalResponse>(
      '/api/workers/poll-auth-signal',
      req as unknown as Record<string, unknown>
    );
  }

  /**
   * Report auth run completion — writes credentials + metadata to auth_profiles.
   */
  async completeAuth(req: CompleteAuthRequest): Promise<void> {
    await this.requestVoid('/api/workers/complete-auth', req as unknown as Record<string, unknown>);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/api/health`, {
        headers: this.authHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  get id(): string {
    return this.workerId;
  }
}

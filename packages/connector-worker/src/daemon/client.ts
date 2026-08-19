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
  /**
   * Forward a chrome-extension action call from the running connector to the
   * gateway, which enqueues a chrome connector action run, waits for the
   * paired Owletto extension to claim/complete, and returns the observation
   * — multi-replica safe because the wait is Postgres-mediated.
   */
  dispatchChromeAction(req: DispatchChromeActionRequest): Promise<Record<string, unknown>>;
  /**
   * Post a device-side automation exit report and read the server's decision.
   * `status: "resume"` means the run is still claimed and the caller should
   * re-spawn with the returned nudge.
   */
  completeAutomation(
    runId: number,
    req: CompleteAutomationRequest
  ): Promise<CompleteAutomationResponse>;
  /** MCP endpoint + bearer the automation arm wires into the spawned CLI. */
  readonly mcpWiring?: { url: string; bearer?: string };
}

// ============================================
// Types
// ============================================

/**
 * The worker⇄gateway wire payloads are the SINGLE SOURCE in
 * `@lobu/core/contracts/worker/protocol` (TypeBox). Re-exported here so this
 * module's public surface is unchanged for importers, while the server annotates
 * its request-body reads with the same shapes from that file.
 */
export type {
  CompleteActionRequest,
  CompleteAuthRequest,
  CompleteAutomationRequest,
  CompleteAutomationResponse,
  CompleteEmbeddingsRequest,
  CompleteRequest,
  ContentItem,
  DispatchChromeActionRequest,
  DispatchChromeActionResponse,
  EmbedEvent,
  EmitAuthArtifactRequest,
  OAuthCredentials,
  PollAuthSignalRequest,
  PollAuthSignalResponse,
  PollResponse,
  StreamBatch,
} from "@lobu/core/contracts/worker/protocol";
import type {
  CompleteActionRequest,
  CompleteAuthRequest,
  CompleteAutomationRequest,
  CompleteAutomationResponse,
  CompleteEmbeddingsRequest,
  CompleteRequest,
  DispatchChromeActionRequest,
  DispatchChromeActionResponse,
  EmbedEvent,
  EmitAuthArtifactRequest,
  PollAuthSignalRequest,
  PollAuthSignalResponse,
  PollResponse,
  StreamBatch,
} from "@lobu/core/contracts/worker/protocol";
import { AGENT_KINDS } from "@lobu/core/contracts/worker/device-automation";

/** Capability strings the worker advertises, keyed by name (e.g. `browser.debugger`). */
export type WorkerCapabilities = Record<string, boolean>;

/** HTTP error carrying the status code, so delivery retries can classify it. */
export class WorkerHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    body: string
  ) {
    super(`${path} failed: ${status} ${body.slice(0, 500)}`);
    this.name = 'WorkerHttpError';
  }
}

/**
 * A 2xx body we could not read as a completion decision. The server answered,
 * so re-sending would only mangle the same body — non-retriable.
 */
export class WorkerDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerDecodeError';
  }
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
  private platform?: string;
  private label?: string;
  private manifests: unknown[] = [];

  constructor(config: {
    apiUrl: string;
    workerId: string;
    authToken?: string;
    capabilities: WorkerCapabilities;
    version?: string;
    /** Host platform for server-side device registration and capability authorization. */
    platform?: string;
    /** Human-readable device name for the Devices page. */
    label?: string;
    /** Device-manifest connector definitions to register on each poll. */
    manifests?: unknown[];
  }) {
    this.apiUrl = trimTrailingSlashes(config.apiUrl);
    this.workerId = config.workerId;
    this.capabilities = config.capabilities;
    this.authToken = config.authToken?.trim() || undefined;
    this.version = config.version ?? '1.0.0';
    this.platform = config.platform?.trim() || undefined;
    this.label = config.label?.trim() || undefined;
    this.manifests = config.manifests ?? [];
  }

  private authHeaders(): Record<string, string> {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
  }

  private async post<B = unknown>(path: string, body: B): Promise<Response> {
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
    return response;
  }

  private async requestJson<T, B = unknown>(path: string, body: B): Promise<T> {
    const response = await this.post(path, body);
    return response.json() as Promise<T>;
  }

  private async requestVoid<B = unknown>(path: string, body: B): Promise<void> {
    await this.post(path, body);
  }

  /**
   * Poll for available runs
   */
  async poll(): Promise<PollResponse> {
    return this.requestJson<PollResponse>('/api/workers/poll', {
      worker_id: this.workerId,
      capabilities: this.capabilities,
      version: this.version,
      // app_version belongs to the device registration fields, so omit both for
      // fleet workers rather than sending empty values. A device worker also
      // advertises the agent kinds its automation arm can run.
      ...(this.platform
        ? {
            platform: this.platform,
            app_version: this.version,
            agent_kinds: AGENT_KINDS,
          }
        : {}),
      ...(this.label ? { label: this.label } : {}),
      ...(this.manifests.length > 0 ? { connector_manifests: this.manifests } : {}),
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
    await this.requestVoid('/api/workers/stream', batch);
  }

  /**
   * Report sync run completion
   */
  async complete(req: CompleteRequest): Promise<void> {
    await this.requestVoid('/api/workers/complete', req);
  }

  /**
   * Report action run completion
   */
  async completeAction(req: CompleteActionRequest): Promise<void> {
    await this.requestVoid(
      '/api/workers/complete-action',
      req
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
      req
    );
  }

  /**
   * Emit an auth artifact (QR, redirect URL, prompt) for the UI to render.
   */
  async emitAuthArtifact(req: EmitAuthArtifactRequest): Promise<void> {
    await this.requestVoid(
      '/api/workers/emit-auth-artifact',
      req
    );
  }

  /**
   * Poll for a signal sent by the UI (OAuth callback, form submit, cancel).
   */
  async pollAuthSignal(req: PollAuthSignalRequest): Promise<PollAuthSignalResponse> {
    return this.requestJson<PollAuthSignalResponse>(
      '/api/workers/poll-auth-signal',
      req
    );
  }

  /**
   * Report auth run completion — writes credentials + metadata to auth_profiles.
   */
  async completeAuth(req: CompleteAuthRequest): Promise<void> {
    await this.requestVoid('/api/workers/complete-auth', req);
  }

  /**
   * Forward a chrome connector action call to the gateway. Blocks until the
   * paired Owletto extension completes the run or the gateway-side budget
   * times out. Throws on failure/timeout with the gateway's error message.
   */
  async dispatchChromeAction(req: DispatchChromeActionRequest): Promise<Record<string, unknown>> {
    const result = await this.requestJson<DispatchChromeActionResponse>(
      '/api/workers/dispatch-chrome-action',
      req
    );
    if (result.status === 'completed') {
      return result.output ?? {};
    }
    throw new Error(
      result.error_message ??
        `Chrome action '${req.action_key}' ${result.status === 'timeout' ? 'timed out' : 'failed'}`
    );
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

  /**
   * Device-side EXIT REPORT for an automation run. Posts the process exit
   * metadata and returns the server's decision; see
   * `interpretCompleteAutomationResponse` for how a 2xx body is read without
   * inventing an outcome.
   */
  async completeAutomation(
    runId: number,
    req: CompleteAutomationRequest
  ): Promise<CompleteAutomationResponse> {
    const path = `/api/workers/me/runs/${runId}/complete-automation`;
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(req),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new WorkerHttpError(response.status, path, text);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WorkerDecodeError(
        `complete-automation returned an unrecognised 2xx body`
      );
    }
    return interpretCompleteAutomationResponse(body);
  }

  get mcpWiring(): { url: string; bearer?: string } | undefined {
    if (!this.authToken) return undefined;
    return { url: `${this.apiUrl}/mcp`, bearer: this.authToken };
  }

  get id(): string {
    return this.workerId;
  }
}

/**
 * A 2xx body from `complete-automation`, read without inventing an outcome.
 * Anything not recognised throws `WorkerDecodeError` — the server answered, so
 * the caller must not re-send and must not report a fabricated outcome.
 */
export function interpretCompleteAutomationResponse(
  body: unknown
): CompleteAutomationResponse {
  if (
    body != null &&
    typeof body === 'object' &&
    typeof (body as Record<string, unknown>).status === 'string'
  ) {
    return body as CompleteAutomationResponse;
  }
  // The one legitimate legacy shape: a minimal 2xx object with no `status`.
  // Recognised explicitly — and still rejected if it signals failure.
  const ack = body as { ok?: boolean | null; error?: string | null } | null;
  if (ack != null && typeof ack === 'object' && ack.error == null && ack.ok !== false) {
    return { ok: true, status: 'completed' };
  }
  throw new WorkerDecodeError(
    'complete-automation returned an unrecognised 2xx body'
  );
}

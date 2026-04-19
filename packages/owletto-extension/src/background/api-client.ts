/**
 * API Client
 * Handles communication with the Owletto API
 * Reuses existing worker protocol (poll, stream, complete)
 */

import type { AuthManager } from './auth';
import type { ExtractorDefinition, StateManager } from './state-manager';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5173';

export interface Job {
  run_id: number;
  connector_key: string;
  feed_key?: string;
  config: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
}

export interface StreamItem {
  id: string;
  content: string;
  title?: string;
  author?: string;
  published_at?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface CompleteResult {
  status: 'success' | 'failed';
  items_collected?: number;
  error_message?: string;
  checkpoint?: Record<string, unknown>;
}

export interface WorkerCapabilities {
  browser: boolean;
}

export class ApiClient {
  private workerId?: string;

  constructor(
    private auth: AuthManager,
    private state: StateManager
  ) {}

  /**
   * Make an authenticated API request
   * Uses Bearer token for auth (stored from OAuth callback)
   */
  private async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.auth.getSessionToken();

    if (!token) {
      throw new Error('Not authenticated');
    }

    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);

    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });

    // Handle auth errors
    if (response.status === 401) {
      throw new Error('Authentication expired');
    }

    return response;
  }

  /**
   * Register this extension as a worker
   */
  async register(): Promise<string> {
    const existingId = await this.state.get('workerId');
    if (existingId) {
      this.workerId = existingId;
      return existingId;
    }

    const newWorkerId = crypto.randomUUID();
    this.workerId = newWorkerId;
    await this.state.set('workerId', newWorkerId);

    console.log('[Owletto] Registered local worker identity:', newWorkerId);
    return newWorkerId;
  }

  /**
   * Poll for available jobs
   */
  async poll(): Promise<Job[]> {
    if (!this.workerId) {
      await this.register();
    }

    const capabilities: WorkerCapabilities = { browser: true };
    const response = await this.fetch('/api/workers/poll', {
      method: 'POST',
      body: JSON.stringify({
        worker_id: this.workerId,
        capabilities,
      }),
    });

    if (!response.ok) {
      throw new Error(`Poll failed: ${response.status}`);
    }

    const data = await response.json();
    if (typeof data.run_id !== 'number' || typeof data.connector_key !== 'string') {
      return [];
    }

    return [
      {
        run_id: data.run_id,
        connector_key: data.connector_key,
        feed_key: typeof data.feed_key === 'string' ? data.feed_key : undefined,
        config: (data.config as Record<string, unknown> | undefined) ?? {},
        checkpoint: (data.checkpoint as Record<string, unknown> | undefined) ?? undefined,
      },
    ];
  }

  /**
   * Stream extracted items to the server
   */
  async stream(runId: number, items: StreamItem[]): Promise<void> {
    const response = await this.fetch('/api/workers/stream', {
      method: 'POST',
      body: JSON.stringify({
        type: 'batch',
        run_id: runId,
        items: items.map((item) => ({
          id: item.id,
          title: item.title,
          payload_text: item.content,
          author_name: item.author,
          occurred_at: item.published_at ?? new Date().toISOString(),
          source_url: item.url,
          metadata: item.metadata,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Stream failed: ${response.status}`);
    }
  }

  /**
   * Mark a job as complete
   */
  async complete(runId: number, result: CompleteResult): Promise<void> {
    if (!this.workerId) {
      await this.register();
    }

    const response = await this.fetch('/api/workers/complete', {
      method: 'POST',
      body: JSON.stringify({
        run_id: runId,
        worker_id: this.workerId,
        ...result,
      }),
    });

    if (!response.ok) {
      throw new Error(`Complete failed: ${response.status}`);
    }
  }

  /**
   * Get platform configurations (extractor definitions)
   */
  async getConfig(): Promise<ExtractorDefinition[]> {
    const cachedConfigs = await this.state.get('extractorConfigs');
    return cachedConfigs ? Object.values(cachedConfigs) : [];
  }
}

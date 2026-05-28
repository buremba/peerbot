/**
 * Unit tests for extensionNetworkSync. Drives the helper with a stub
 * ChromeActionDispatcher that records dispatched action_keys and returns
 * canned observations — including a programmable buffer of intercepted
 * responses the drain action hands back.
 */

import { describe, expect, test } from 'bun:test';
import type {
  ChromeActionDispatcher,
  InterceptedResponse,
  NavigateObservation,
  NetworkInterceptDrainObservation,
  NetworkInterceptStartObservation,
} from '../extension-network.js';
import { extensionNetworkSync } from '../extension-network.js';

interface DispatchLog {
  action: string;
  input: Record<string, unknown>;
}

function makeDispatcher({
  navUrl = 'https://www.linkedin.com/company/openai/posts/',
  drainQueues = [] as InterceptedResponse[][],
}: {
  navUrl?: string;
  drainQueues?: InterceptedResponse[][];
} = {}): { dispatcher: ChromeActionDispatcher; log: DispatchLog[] } {
  const log: DispatchLog[] = [];
  let drainIdx = 0;
  const dispatcher: ChromeActionDispatcher = {
    dispatch: async (action: string, input: Record<string, unknown>) => {
      log.push({ action, input });
      if (action === 'navigate') {
        return {
          tab_id: 555,
          current_url: navUrl,
          title: 'stub',
        } as NavigateObservation as never;
      }
      if (action === 'network_intercept_start') {
        return {
          session_id: 'netint-stub-1',
          tab_id: 555,
          resumed: false,
        } as NetworkInterceptStartObservation as never;
      }
      if (action === 'network_intercept_drain') {
        const batch = drainQueues[drainIdx] ?? [];
        drainIdx++;
        return {
          session_id: 'netint-stub-1',
          drained: batch.length,
          missing: false,
          responses: batch,
        } as NetworkInterceptDrainObservation as never;
      }
      // network_intercept_stop, evaluate (scroll), close_tab — caller doesn't
      // care about the return value.
      return {} as never;
    },
  };
  return { dispatcher, log };
}

function makeResponse(url: string, json: unknown): InterceptedResponse {
  return {
    url,
    status: 200,
    mime: 'application/json',
    body: JSON.stringify(json),
    base64_encoded: false,
    truncated: false,
    ts: Date.now(),
  };
}

describe('extensionNetworkSync', () => {
  test('navigate → start → drain → stop → close_tab sequence', async () => {
    const { dispatcher, log } = makeDispatcher({
      drainQueues: [
        [makeResponse('https://x.com/api/foo', { items: [1, 2, 3] })],
        // Empty drain → triggers no-new-items stop on scroll 1.
        [],
      ],
    });
    const result = await extensionNetworkSync<number>({
      dispatcher,
      url: 'https://x.com/feed',
      config: {
        interceptPatterns: ['**/api/**'],
        maxScrolls: 3,
        scrollDelayMs: 0,
        responseTimeoutMs: 0,
      },
      parseResponse: (_url, json) => {
        const j = json as { items: number[] };
        return j.items ?? [];
      },
    });
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.backend).toBe('extension');
    expect(result.apiCallCount).toBe(1);
    const actions = log.map((l) => l.action);
    expect(actions[0]).toBe('navigate');
    expect(actions[1]).toBe('network_intercept_start');
    // At least one drain, one stop, one close_tab.
    expect(actions).toContain('network_intercept_drain');
    expect(actions).toContain('network_intercept_stop');
    expect(actions).toContain('close_tab');
  });

  test('respects checkAuth and bails early', async () => {
    const { dispatcher } = makeDispatcher({
      navUrl: 'https://www.linkedin.com/login',
    });
    await expect(
      extensionNetworkSync({
        dispatcher,
        url: 'https://www.linkedin.com/company/openai/posts/',
        config: { interceptPatterns: ['**/voyager/**'] },
        parseResponse: () => [],
        checkAuth: (currentUrl) =>
          !currentUrl.includes('/login') && !currentUrl.includes('/authwall'),
      }),
    ).rejects.toThrow(/auth check failed/);
  });

  test('paginates across multiple drains until empty', async () => {
    const { dispatcher, log } = makeDispatcher({
      drainQueues: [
        [makeResponse('https://x.com/api/p1', { items: ['a'] })],
        [makeResponse('https://x.com/api/p2', { items: ['b'] })],
        [makeResponse('https://x.com/api/p3', { items: ['c'] })],
        [],
      ],
    });
    const result = await extensionNetworkSync<string>({
      dispatcher,
      url: 'https://x.com/feed',
      config: {
        interceptPatterns: ['**/api/**'],
        maxScrolls: 5,
        scrollDelayMs: 0,
        responseTimeoutMs: 0,
      },
      parseResponse: (_url, json) => (json as { items: string[] }).items,
    });
    expect(result.items).toEqual(['a', 'b', 'c']);
    const evalCalls = log.filter(
      (l) => l.action === 'evaluate' && typeof l.input.expression === 'string',
    );
    // Scrolled at least once before stopping.
    expect(evalCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('skips non-JSON intercepted bodies without crashing', async () => {
    const { dispatcher } = makeDispatcher({
      drainQueues: [
        [
          {
            url: 'https://x.com/api/broken',
            status: 200,
            mime: 'application/json',
            body: 'not json {{{',
            base64_encoded: false,
            truncated: false,
            ts: Date.now(),
          },
          makeResponse('https://x.com/api/good', { items: ['ok'] }),
        ],
        [],
      ],
    });
    const result = await extensionNetworkSync<string>({
      dispatcher,
      url: 'https://x.com/feed',
      config: {
        interceptPatterns: ['**/api/**'],
        maxScrolls: 1,
        scrollDelayMs: 0,
        responseTimeoutMs: 0,
      },
      parseResponse: (_url, json) => (json as { items: string[] }).items,
    });
    expect(result.items).toEqual(['ok']);
  });

  test('skips base64 (binary) bodies', async () => {
    const { dispatcher } = makeDispatcher({
      drainQueues: [
        [
          {
            url: 'https://x.com/api/img',
            status: 200,
            mime: 'image/png',
            body: 'AAAAAA==',
            base64_encoded: true,
            truncated: false,
            ts: Date.now(),
          },
        ],
        [],
      ],
    });
    const result = await extensionNetworkSync<string>({
      dispatcher,
      url: 'https://x.com/feed',
      config: {
        interceptPatterns: ['**/api/**'],
        maxScrolls: 1,
        scrollDelayMs: 0,
        responseTimeoutMs: 0,
      },
      parseResponse: () => ['parsed'],
    });
    expect(result.items).toEqual([]);
  });

  test('always stops session + closes tab on error', async () => {
    const log: DispatchLog[] = [];
    const dispatcher: ChromeActionDispatcher = {
      dispatch: async (action: string, input: Record<string, unknown>) => {
        log.push({ action, input });
        if (action === 'navigate') {
          return { tab_id: 555, current_url: 'https://x.com/feed', title: '' } as never;
        }
        if (action === 'network_intercept_start') {
          return { session_id: 's', tab_id: 555, resumed: false } as never;
        }
        if (action === 'network_intercept_drain') {
          throw new Error('boom');
        }
        return {} as never;
      },
    };
    await expect(
      extensionNetworkSync({
        dispatcher,
        url: 'https://x.com/feed',
        config: {
          interceptPatterns: ['**/api/**'],
          maxScrolls: 0,
          scrollDelayMs: 0,
          responseTimeoutMs: 0,
        },
        parseResponse: () => [],
      }),
    ).rejects.toThrow(/boom/);
    const actions = log.map((l) => l.action);
    expect(actions).toContain('network_intercept_stop');
    expect(actions).toContain('close_tab');
  });
});

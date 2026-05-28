/**
 * Extension Network Sync
 *
 * Mirror of `browserNetworkSync` (browser-network.ts) that runs against the
 * Owletto Chrome extension instead of a Playwright-launched browser. Same
 * shape — `interceptPatterns`, `parseResponse`, scroll loop — but the
 * driver is a series of `chrome.*` connector actions enqueued through the
 * caller-supplied `ChromeActionDispatcher`.
 *
 * Why this exists: server-side connectors today use `browserNetworkSync`,
 * which spawns a Playwright window for every run. That's heavy and runs
 * outside the user's real session (cookies / cdp-url plumbing). The
 * extension stack already gives us a debugger-attached tab inside the
 * user's signed-in Chrome — adding a Network-domain primitive
 * (apps/chrome/network-intercept.js) lets the same parse pipeline run
 * there for free.
 *
 * Wire shape: the dispatcher returns the same `observation` envelope the
 * extension produces on /api/workers/complete-action. Connectors don't
 * need to know how the run is routed (sync vs queued) — they just await
 * the dispatcher.
 *
 * Non-goal: this does NOT replace `browserNetworkSync` yet. The two
 * coexist while we migrate, gated per connector via a config flag.
 */

import { sdkLogger } from './logger.js';

// ── Wire types (mirror apps/chrome/network-intercept.js + chrome connector) ──

export type ExtensionNetworkPattern = string | { regex: string; flags?: string };

export interface InterceptedResponse {
  url: string;
  status: number;
  mime: string;
  /** Body text. May be truncated; see `truncated`. */
  body: string;
  /** True when Chrome returned the body base64-encoded (e.g. binary content). */
  base64_encoded?: boolean;
  truncated?: boolean;
  ts: number;
}

export interface NavigateObservation {
  tab_id: number;
  current_url: string;
  title: string;
  [k: string]: unknown;
}

export interface NetworkInterceptStartObservation {
  session_id: string;
  tab_id: number;
  resumed: boolean;
  [k: string]: unknown;
}

export interface NetworkInterceptDrainObservation {
  session_id: string;
  drained: number;
  missing: boolean;
  responses: InterceptedResponse[];
  [k: string]: unknown;
}

export type ChromeActionInput = Record<string, unknown>;
export type ChromeActionOutput = Record<string, unknown>;

/**
 * Caller-supplied bridge to the Owletto extension. The server wires this
 * to its run-scheduling API (enqueue a run on the chrome connector with
 * `action_key=<action>`, await /complete-action, surface the observation).
 *
 * Decoupled so the connector code is unit-testable: tests pass a stub
 * dispatcher, the production worker passes the real one.
 */
export interface ChromeActionDispatcher {
  dispatch<T extends ChromeActionOutput = ChromeActionOutput>(
    action_key: string,
    action_input: ChromeActionInput
  ): Promise<T>;
}

// ── Config ────────────────────────────────────────────────────────────────

export interface ExtensionNetworkConfig {
  /** URL patterns to intercept (glob string or {regex} object). */
  interceptPatterns: ExtensionNetworkPattern[];
  /** Maximum scroll iterations (default 10). */
  maxScrolls?: number;
  /** Delay between scrolls in ms (default 2000). */
  scrollDelayMs?: number;
  /**
   * How long to wait for at least one response after each scroll before
   * declaring no-more-pages. Default 5000.
   */
  responseTimeoutMs?: number;
  /**
   * Per-session response buffer cap. Default 200 — higher than the
   * Playwright path because the extension caps the buffer FIFO-style and
   * we don't want a slow drain to lose batches between scrolls.
   */
  maxBufferResponses?: number;
  /** Per-response body cap. Default 1 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_CONFIG = {
  maxScrolls: 10,
  scrollDelayMs: 2000,
  responseTimeoutMs: 5000,
  maxBufferResponses: 200,
  maxBodyBytes: 1024 * 1024,
};

export interface ExtensionNetworkResult<TItem> {
  items: TItem[];
  apiCallCount: number;
  backend: 'extension';
}

// ── Main entrypoint ───────────────────────────────────────────────────────

/**
 * Drive a navigate → start → (scroll → drain){,n} → stop pipeline against
 * the extension. Mirrors `browserNetworkSync` but emits action runs instead
 * of driving a Playwright Page.
 */
export async function extensionNetworkSync<TItem>(opts: {
  dispatcher: ChromeActionDispatcher;
  config: ExtensionNetworkConfig;
  url: string;
  /**
   * Parse one intercepted JSON response into zero-or-more items. The
   * extension hands us the raw body string; we JSON.parse here so the
   * connector's parser sees the same `unknown` it does in the Playwright
   * path.
   */
  parseResponse: (url: string, json: unknown) => TItem[];
  /**
   * Best-effort auth check from the post-navigate URL. The extension
   * returns the resolved `current_url` after Page.frameStoppedLoading;
   * callers compare it against known redirect destinations
   * (/login, /authwall, …).
   */
  checkAuth?: (currentUrl: string) => boolean;
  /**
   * Custom pagination trigger. Defaults to dispatching an `evaluate`
   * action that runs `window.scrollTo(0, document.documentElement.scrollHeight)`.
   */
  triggerNextPage?: (tabId: number, dispatcher: ChromeActionDispatcher) => Promise<void>;
}): Promise<ExtensionNetworkResult<TItem>> {
  const cfg = { ...DEFAULT_CONFIG, ...opts.config };
  const items: TItem[] = [];
  let apiCallCount = 0;

  // 1. navigate into a fresh background tab.
  const navObs = await opts.dispatcher.dispatch<NavigateObservation>('navigate', {
    url: opts.url,
    open_in_new_tab: true,
    wait_for_load: true,
  });
  const tabId = navObs.tab_id;
  sdkLogger.info(
    { tabId, currentUrl: navObs.current_url },
    '[ExtensionNetwork] navigated'
  );

  if (opts.checkAuth && !opts.checkAuth(navObs.current_url)) {
    await safeStop(opts.dispatcher, null);
    await safeCloseTab(opts.dispatcher, tabId);
    throw new Error(
      'extensionNetworkSync: auth check failed — Chrome session is not logged in to this site'
    );
  }

  // 2. start intercept BEFORE any scroll so the first batch of responses
  // (the page's initial XHR/GraphQL calls during render) is captured. The
  // extension's start() attaches the Network domain synchronously; any
  // request that's already in-flight when start() returns will be seen.
  // Anything that finished before start() is lost — same as the Playwright
  // page.on('response') lifecycle.
  const startObs = await opts.dispatcher.dispatch<NetworkInterceptStartObservation>(
    'network_intercept_start',
    {
      tab_id: tabId,
      patterns: opts.config.interceptPatterns,
      max_buffer_responses: cfg.maxBufferResponses,
      max_body_bytes: cfg.maxBodyBytes,
    }
  );
  const sessionId = startObs.session_id;

  try {
    // 3. give the initial render a chance to fire its XHRs, then drain.
    await sleep(cfg.responseTimeoutMs);
    apiCallCount += await drainInto(items, opts, sessionId);

    // 4. scroll loop. Each iteration: trigger pagination, wait, drain.
    let prev = items.length;
    for (let n = 0; n < cfg.maxScrolls; n++) {
      const trigger =
        opts.triggerNextPage ??
        (async (tid: number, dispatch: ChromeActionDispatcher) => {
          await dispatch.dispatch('evaluate', {
            tab_id: tid,
            expression:
              'window.scrollTo(0, document.documentElement.scrollHeight); 1',
          });
        });
      await trigger(tabId, opts.dispatcher);
      await sleep(cfg.scrollDelayMs);
      apiCallCount += await drainInto(items, opts, sessionId);

      if (items.length === prev) {
        sdkLogger.info(
          { scroll: n + 1 },
          '[ExtensionNetwork] no new items, stopping pagination'
        );
        break;
      }
      sdkLogger.info(
        { scroll: n + 1, newItems: items.length - prev, total: items.length },
        '[ExtensionNetwork] scroll'
      );
      prev = items.length;
    }

    return { items, apiCallCount, backend: 'extension' };
  } finally {
    await safeStop(opts.dispatcher, sessionId);
    await safeCloseTab(opts.dispatcher, tabId);
  }

  // Helper kept inside the closure so it sees the `cfg` + `opts` typed Ts above.
  async function drainInto(
    sink: TItem[],
    o: typeof opts,
    sid: string
  ): Promise<number> {
    const drained = await o.dispatcher.dispatch<NetworkInterceptDrainObservation>(
      'network_intercept_drain',
      { session_id: sid }
    );
    let calls = 0;
    for (const resp of drained.responses ?? []) {
      calls++;
      if (resp.base64_encoded) {
        // Skip binary bodies — connectors using this helper want JSON.
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(resp.body);
      } catch {
        sdkLogger.warn(
          { url: resp.url, bodyLen: resp.body?.length ?? 0 },
          '[ExtensionNetwork] non-JSON intercepted body, skipped'
        );
        continue;
      }
      const parsed = o.parseResponse(resp.url, json);
      sink.push(...parsed);
    }
    return calls;
  }
}

async function safeStop(dispatcher: ChromeActionDispatcher, sessionId: string | null) {
  if (!sessionId) return;
  try {
    await dispatcher.dispatch('network_intercept_stop', { session_id: sessionId });
  } catch (err) {
    sdkLogger.warn({ err, sessionId }, '[ExtensionNetwork] stop failed (already gone?)');
  }
}

async function safeCloseTab(dispatcher: ChromeActionDispatcher, tabId: number) {
  try {
    await dispatcher.dispatch('close_tab', { tab_id: tabId });
  } catch (err) {
    sdkLogger.warn({ err, tabId }, '[ExtensionNetwork] close_tab failed (already gone?)');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

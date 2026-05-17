/**
 * Browser Evaluate Connector — Owletto for Chrome only.
 *
 * Runs on the Owletto Chrome extension, which advertises capability
 * `browser.debugger`. The extension attaches `chrome.debugger` to a tab,
 * optionally navigates + waits for a selector, runs the supplied JS via
 * `Runtime.evaluate`, and emits one event with the JSON-serialised result.
 *
 * This is the generic "agent runs JS in a user's signed-in Chrome" primitive
 * — most bridge connectors (Revolut feed, banking, sites that fingerprint
 * a managed Chromium) compose on top of `browser.evaluate` rather than
 * shipping their own connector. The trust boundary is `config.script`: only
 * the gateway-side connector author should mint it. The extension defaults
 * to opening a fresh background tab so a compromised gateway / leaked token
 * can't drive the tab a user is actively using; see executor.js in
 * owletto-web for the full threat model.
 *
 * Cloud-side `sync()` / `execute()` throw — actual work happens in the
 * extension's service worker (lobu-ai/owletto: apps/chrome/executor.js).
 */

import {
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'browser.evaluate runs only on a worker advertising capability "browser.debugger" (Owletto for Chrome).';

export default class BrowserEvaluateConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'browser.evaluate',
    name: 'Browser Evaluate',
    description:
      'Runs a JS snippet in a page via chrome.debugger and emits the result. The primitive most bridge connectors build on.',
    version: '0.1.0',
    faviconDomain: 'google.com',
    requiredCapability: 'browser.debugger',
    runtime: { platforms: ['chrome-extension'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      evaluate: {
        key: 'evaluate',
        name: 'Evaluate JS',
        description:
          'Executes a JS expression in the page and emits one event with the JSON-serialised return value.',
        // `script` is required and gateway-author-supplied. Auto-wire would
        // insert a feed row with config=NULL and produce a runs-but-fails
        // loop. Bridge connectors (Revolut, banking, etc.) compose by
        // creating explicit feed instances per call site.
        userManaged: true,
        configSchema: {
          type: 'object',
          required: ['script'],
          properties: {
            url: {
              type: 'string',
              format: 'uri',
              description: 'If set, navigate the tab here before evaluating.',
            },
            script: {
              type: 'string',
              description:
                'JS expression evaluated with Runtime.evaluate(awaitPromise: true). Return value is JSON-serialised — keep it small.',
            },
            wait_for_selector: {
              type: 'string',
              description:
                'CSS selector to wait for before evaluating (polled every 200ms via Runtime.evaluate).',
            },
            wait_timeout_ms: {
              type: 'integer',
              minimum: 100,
              maximum: 60_000,
              description: 'Timeout for wait_for_selector. Default 10000.',
            },
            open_in_new_tab: {
              type: 'boolean',
              description:
                'Open a fresh background tab instead of driving the active tab. DEFAULT TRUE — opt out only when you specifically need the user-active tab.',
            },
            close_tab_after: {
              type: 'boolean',
              description:
                'Close the tab when the run completes. Defaults to true when open_in_new_tab is true.',
            },
          },
        },
        eventKinds: {
          browser_evaluate: {
            description:
              'One event per run with the JSON-serialised Runtime.evaluate result.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id'],
              properties: {
                source: { type: 'string', const: 'browser_evaluate' },
                origin_id: { type: 'string' },
                url: { type: 'string' },
                title: { type: 'string' },
                tab_id: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(BRIDGE_ONLY);
  }

  async execute(): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY);
  }
}

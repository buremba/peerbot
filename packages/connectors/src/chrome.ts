/**
 * Chrome Connector — Owletto for Chrome only.
 *
 * One connector per paired Chrome profile. Exposes the worker's browser
 * capabilities as a coherent set of feeds rather than as four standalone
 * "connectors" the admin UI had to render as peers under one device.
 *
 * Feeds:
 *   - `open_tabs`     auto-wired feed: snapshot of currently-open tabs.
 *   - `evaluate`      userManaged: run JS via chrome.debugger and emit the
 *                     JSON-serialised result. The generic "agent runs JS in
 *                     a user's signed-in Chrome" primitive that bridge
 *                     connectors (Revolut, banking, …) compose on.
 *   - `page_text`     userManaged: thin wrapper around evaluate with a
 *                     canonical readable-text extraction script.
 *   - `fill_form`     userManaged: thin wrapper around evaluate that fills
 *                     inputs by CSS selector and optionally clicks submit.
 *
 * Required worker capability is `browser.debugger` — the strict union of
 * what these feeds need (evaluate / page_text / fill_form all need it; the
 * tabs feed only needs `browser.tabs`, but a worker that has debugger always
 * has tabs in practice, and connector-level capability is the only gate the
 * SDK currently supports).
 *
 * Cloud-side `sync()` / `execute()` throw — actual work happens in the
 * extension's service worker (lobu-ai/owletto: apps/chrome/background.js and
 * apps/chrome/executor.js). The extension dispatches by feed_key under the
 * unified `chrome` connector key.
 */

import {
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'chrome runs only on a worker advertising capability "browser.debugger" (Owletto for Chrome).';

export default class ChromeConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'chrome',
    name: 'Chrome',
    description:
      'Paired Chrome profile. Exposes open-tab snapshots and a chrome.debugger-backed JS/page-text/form-fill primitive set the agent can compose against.',
    version: '0.2.0',
    faviconDomain: 'google.com',
    requiredCapability: 'browser.debugger',
    runtime: { platforms: ['chrome-extension'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      open_tabs: {
        key: 'open_tabs',
        name: 'Open tabs',
        description: 'Snapshot of the tabs currently open in this Chrome profile.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          tab_snapshot: {
            description: 'One row per tab observed in the active poll cycle.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'url'],
              properties: {
                source: { type: 'string', const: 'chrome_tabs' },
                origin_id: { type: 'string' },
                url: { type: 'string', format: 'uri' },
                title: { type: 'string' },
                window_id: { type: 'integer' },
                active: { type: 'boolean' },
              },
            },
          },
        },
      },
      evaluate: {
        key: 'evaluate',
        name: 'Evaluate JS',
        description:
          'Executes a JS expression in the page via chrome.debugger and emits one event with the JSON-serialised return value.',
        // `script` is required and gateway-author-supplied. Auto-wire would
        // insert a feed row with config=NULL and produce a runs-but-fails
        // loop. Bridge connectors (Revolut, banking, …) compose by creating
        // explicit feed instances per call site.
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
      page_text: {
        key: 'page_text',
        name: 'Page text',
        description: 'Snapshot of the readable text content of a single page.',
        // Required url; instances are minted by composing bridge connectors,
        // not auto-wired by device-reconcile.
        userManaged: true,
        configSchema: {
          type: 'object',
          required: ['url'],
          properties: {
            url: {
              type: 'string',
              format: 'uri',
              description: 'Page to load and read text from.',
            },
            selector: {
              type: 'string',
              description:
                'CSS selector to scope the extraction to (defaults to body.innerText).',
            },
            wait_for_selector: {
              type: 'string',
              description:
                'CSS selector to wait for before reading (defaults to body).',
            },
            wait_timeout_ms: {
              type: 'integer',
              minimum: 100,
              maximum: 60_000,
            },
            max_chars: {
              type: 'integer',
              minimum: 100,
              maximum: 1_000_000,
              description: 'Truncate output past this length. Default 200000.',
            },
          },
        },
        eventKinds: {
          page_text: {
            description:
              'One event per run containing the page text (truncated to max_chars).',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'url'],
              properties: {
                source: { type: 'string', const: 'browser_page_text' },
                origin_id: { type: 'string' },
                url: { type: 'string', format: 'uri' },
                title: { type: 'string' },
                char_count: { type: 'integer' },
                truncated: { type: 'boolean' },
              },
            },
          },
        },
      },
      fill_form: {
        key: 'fill_form',
        name: 'Fill form',
        description:
          'Sets values on input/textarea/select elements matched by CSS selector and optionally clicks submit.',
        // Required url + fields; instances are minted by composing bridge
        // connectors, not auto-wired by device-reconcile.
        userManaged: true,
        configSchema: {
          type: 'object',
          required: ['url', 'fields'],
          properties: {
            url: {
              type: 'string',
              format: 'uri',
              description: 'Page to load before filling.',
            },
            fields: {
              type: 'object',
              description:
                'Map of CSS selector → value to set. e.g. { "#email": "x@y.com", "#submit": "click" } — the literal string "click" triggers a click instead of a value set.',
              additionalProperties: { type: 'string' },
            },
            wait_for_selector: {
              type: 'string',
              description:
                'CSS selector to wait for before filling (defaults to the first key of fields).',
            },
            wait_timeout_ms: {
              type: 'integer',
              minimum: 100,
              maximum: 60_000,
            },
            submit_selector: {
              type: 'string',
              description:
                'Optional selector to click after filling all fields (e.g. "button[type=submit]").',
            },
          },
        },
        eventKinds: {
          form_filled: {
            description:
              'One event per run with the count of fields filled + whether submit was clicked.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'url', 'filled_count'],
              properties: {
                source: { type: 'string', const: 'browser_fill_form' },
                origin_id: { type: 'string' },
                url: { type: 'string', format: 'uri' },
                filled_count: { type: 'integer' },
                submitted: { type: 'boolean' },
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

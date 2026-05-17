/**
 * Browser Fill Form Connector — Owletto for Chrome only.
 *
 * Thin wrapper around browser.evaluate that bakes in a "fill these inputs
 * by selector and dispatch the right input/change events" script.
 *
 * The extension's executor branch for `browser.fill_form` substitutes the
 * canonical fill-form script when this connector_key is dispatched. The
 * server-side definition just exposes the URL + fields config to the
 * admin UI.
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
  'browser.fill_form runs only on a worker advertising capability "browser.debugger" (Owletto for Chrome).';

export default class BrowserFillFormConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'browser.fill_form',
    name: 'Browser Fill Form',
    description:
      'Fills inputs on a page by CSS selector and dispatches input/change events. Returns the filled field count.',
    version: '0.1.0',
    faviconDomain: 'google.com',
    requiredCapability: 'browser.debugger',
    runtime: { platforms: ['chrome-extension'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      fill: {
        key: 'fill',
        name: 'Fill form',
        description:
          'Sets values on input/textarea/select elements matched by CSS selector.',
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

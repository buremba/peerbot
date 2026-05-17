/**
 * Browser Page Text Connector — Owletto for Chrome only.
 *
 * Thin wrapper around browser.evaluate that bakes in a "return cleaned-up
 * page text" script. Saves the connector author from re-deriving the
 * text-extraction recipe for every page-scrape feed.
 *
 * The extension's executor branch for `browser.page_text` is responsible
 * for substituting the canonical script when this connector_key is
 * dispatched — gateway-side this connector definition just exposes the
 * URL + selector-scope config to the admin UI.
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
  'browser.page_text runs only on a worker advertising capability "browser.debugger" (Owletto for Chrome).';

export default class BrowserPageTextConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'browser.page_text',
    name: 'Browser Page Text',
    description:
      'Fetches a page in the paired Chrome and returns its readable text content. Wraps browser.evaluate with a canonical text-extraction script.',
    version: '0.1.0',
    faviconDomain: 'google.com',
    requiredCapability: 'browser.debugger',
    runtime: { platforms: ['chrome-extension'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      page: {
        key: 'page',
        name: 'Page text',
        description: 'Snapshot of the text content of a single page.',
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
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(BRIDGE_ONLY);
  }

  async execute(): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY);
  }
}

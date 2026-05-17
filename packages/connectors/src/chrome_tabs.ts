/**
 * Chrome Tabs Connector — Owletto for Chrome only.
 *
 * Runs on the Owletto Chrome extension, which advertises capability
 * `browser.tabs`. The extension uses `chrome.tabs.query()` to list the tabs
 * currently open in the user's paired Chrome profile. No persistent backfill
 * — each sync returns the live tab list at that moment.
 *
 * This connector is the smallest end-to-end demo of the Chrome-extension
 * device protocol: it proves a connector definition can declare a browser
 * capability, get auto-wired into the user's personal org when a
 * `chrome-extension` device polls, and route runs to it.
 *
 * The cloud-side `sync()` / `execute()` throw — actual work happens in the
 * extension's service worker (lobu-ai/owletto: apps/chrome/background.js).
 */

import {
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'Chrome Tabs runs only on a worker advertising capability "browser.tabs" (Owletto for Chrome).';

export default class ChromeTabsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'chrome.tabs',
    name: 'Chrome Tabs',
    description:
      'Lists the tabs currently open in the paired Chrome profile. Read-only; no history or content.',
    version: '0.1.0',
    faviconDomain: 'google.com',
    requiredCapability: 'browser.tabs',
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
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(BRIDGE_ONLY);
  }

  async execute(): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY);
  }
}

/**
 * Chrome Downloads Connector — Owletto for Chrome only.
 *
 * Opt-in ambient feed. The Chrome extension advertises capability
 * `browser.downloads` when the user grants the `downloads` Chrome
 * permission via the sidepanel Permissions panel; the gateway then
 * auto-wires this connector.
 *
 * Emits one event per download (filename, source URL, mime type, size,
 * finish time). Backfills recent downloads on first sync via
 * chrome.downloads.search({}), then streams chrome.downloads.onCreated /
 * onChanged.
 *
 * Cloud-side `sync()` / `execute()` throw — actual work happens in
 * apps/chrome/feeds-downloads.js in the extension.
 */

import {
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'chrome.downloads runs only on a worker advertising capability "browser.downloads" (Owletto for Chrome with downloads permission granted).';

export default class ChromeDownloadsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'chrome.downloads',
    name: 'Chrome downloads',
    description:
      "Files downloaded in the paired Chrome profile, with their source URLs. Opt-in — requires the user to grant the extension's optional `downloads` permission.",
    version: '0.1.0',
    faviconDomain: 'google.com',
    requiredCapability: 'browser.downloads',
    runtime: { platforms: ['chrome-extension'] as unknown as ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      downloads: {
        key: 'downloads',
        name: 'Downloads',
        description:
          'One event per download. Backfills via chrome.downloads.search({}), then streams onCreated / onChanged (state=complete).',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          download: {
            description: 'One row per file the user downloaded.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id'],
              properties: {
                source: { type: 'string', const: 'chrome_downloads' },
                origin_id: { type: 'string' },
                download_id: { type: 'integer' },
                filename: { type: 'string' },
                source_url: { type: 'string', format: 'uri' },
                referrer: { type: 'string' },
                mime: { type: 'string' },
                bytes: { type: 'integer' },
                started_at: { type: 'string', format: 'date-time' },
                finished_at: { type: 'string', format: 'date-time' },
                state: { type: 'string' },
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

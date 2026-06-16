/**
 * Chrome Bookmarks Connector — Owletto for Chrome only.
 *
 * Opt-in ambient feed. The Chrome extension advertises capability
 * `browser.bookmarks` when the user grants the `bookmarks` Chrome
 * permission via the sidepanel Permissions panel; the gateway then
 * auto-wires this connector.
 *
 * Emits one event per bookmark (with its folder path). Backfills the
 * full tree on first sync, then streams `bookmarks.onCreated/onRemoved/
 * onChanged/onMoved` thereafter.
 *
 * Cloud-side `sync()` / `execute()` throw — actual work happens in
 * apps/chrome/feeds-bookmarks.js in the extension.
 */

import { BridgeOnlyConnector, type ConnectorDefinition } from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'chrome.bookmarks runs only on a worker advertising capability "browser.bookmarks" (Owletto for Chrome with bookmarks permission granted).';

export default class ChromeBookmarksConnector extends BridgeOnlyConnector {
  constructor() {
    super(BRIDGE_ONLY);
  }

  readonly definition: ConnectorDefinition = {
    key: 'chrome.bookmarks',
    name: 'Chrome bookmarks',
    description:
      "Bookmarks (and folder structure) from the paired Chrome profile. Opt-in — requires the user to grant the extension's optional `bookmarks` permission.",
    version: '0.1.0',
    faviconDomain: 'google.com',
    requiredCapability: 'browser.bookmarks',
    runtime: { platforms: ['chrome-extension'] as unknown as ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      bookmarks: {
        key: 'bookmarks',
        name: 'Bookmarks',
        description:
          'One event per bookmark. Backfills the full tree on first sync via chrome.bookmarks.getTree, then streams onCreated / onRemoved / onChanged / onMoved.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          bookmark: {
            description: 'One row per bookmark add/remove/edit.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'event_type'],
              properties: {
                source: { type: 'string', const: 'chrome_bookmarks' },
                origin_id: { type: 'string' },
                event_type: {
                  enum: ['created', 'removed', 'changed', 'moved'],
                },
                bookmark_id: { type: 'string' },
                title: { type: 'string' },
                url: { type: 'string' },
                parent_folder_id: { type: 'string' },
                parent_folder_path: { type: 'string' },
                date_added: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    },
  };
}

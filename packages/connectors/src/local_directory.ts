/**
 * Local Directory Connector (V1 runtime) — Lobu for Mac only.
 *
 * Syncs text files (txt/md/json/csv/html) from a local folder on the user's
 * Mac via Lobu for Mac. The app advertises the `local_directory`
 * capability on /api/workers/poll, reads the folder, and streams file events
 * back through the standard worker protocol.
 *
 * The sync() / execute() stubs here throw immediately if a server-side worker
 * somehow bypassed the capability gate — same pattern as apple_screen_time.ts.
 */

import {
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY_MESSAGE =
  'local.directory runs only on a worker advertising capability "local_directory" (Lobu for Mac). ' +
  'This run was claimed by a worker without that capability — check connector_definitions.required_capability and the poll-time capability filter.';

export default class LocalDirectoryConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'local.directory',
    name: 'Local Folder',
    description:
      'Sync text files (txt/md/json/csv/html) from a folder on your Mac via Lobu for Mac.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'local_directory',
    runtime: { platforms: ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      files: {
        key: 'files',
        name: 'Files',
        description: 'Text files from the configured local folder.',
        configSchema: {
          type: 'object',
          properties: {},
        },
        eventKinds: {
          file_document: {
            description: 'A text file from a configured local folder.',
            metadataSchema: {
              type: 'object',
              // No absolute filesystem path — the bridge sends the folder's
              // display name and the file name, which is enough context
              // without leaking the user's home directory / disk layout.
              required: ['source', 'folder', 'name'],
              properties: {
                source: { type: 'string', const: 'local_directory' },
                folder: { type: 'string', description: 'Display name of the local folder.' },
                name: { type: 'string', description: 'File name.' },
                ext: { type: 'string' },
                size_bytes: { type: 'number' },
                modified_at: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(BRIDGE_ONLY_MESSAGE);
  }

  async execute(): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY_MESSAGE);
  }
}

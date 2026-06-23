/**
 * Reminders Connector — Lobu for Mac only.
 *
 * Reads the user's reminders via EventKit on the Mac (Lobu for Mac advertises
 * the `reminders` capability). Incomplete reminders plus recently-completed
 * ones; titles/notes/due-dates/completion flow up, the underlying database
 * stays on the device.
 */

import { BridgeOnlyConnector, type ConnectorDefinition } from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'apple.reminders runs only on a worker advertising capability "reminders" (Lobu for Mac with Reminders access).';

export default class AppleRemindersConnector extends BridgeOnlyConnector {
  constructor() {
    super(BRIDGE_ONLY);
  }

  readonly definition: ConnectorDefinition = {
    key: 'apple.reminders',
    name: 'Reminders',
    description:
      'Sync your reminders (titles, notes, due dates, completion) from this Mac via Lobu for Mac. Reminders stay on the device.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'reminders',
    runtime: { platforms: ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      reminders: {
        key: 'reminders',
        name: 'Reminders',
        description: 'Reminders from the Mac — incomplete plus recently completed.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          reminder: {
            description: 'A single reminder.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'completed'],
              properties: {
                source: { type: 'string', const: 'apple_reminders' },
                origin_id: { type: 'string' },
                list: { type: 'string' },
                completed: { type: 'boolean' },
                due: { type: 'string' },
                completed_at: { type: 'string' },
                priority: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  };
}

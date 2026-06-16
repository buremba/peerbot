/**
 * Apple Screen Time Connector (V1 runtime) — Lobu for Mac only.
 *
 * Runs on Lobu for Mac, which reads `~/Library/Application Support/
 * Knowledge/knowledgeC.db` (the on-device Knowledge store backing Apple's
 * Settings → Screen Time UI). With Full Disk Access granted, the Mac can
 * pull per-app foreground time by day for both Mac usage and (if the user
 * enables Screen Time iCloud sync) iOS usage.
 *
 * iOS does NOT advertise the `screentime` capability — Apple's
 * FamilyControls + DeviceActivityReport design prevents per-app data from
 * leaving the device on iOS. The Mac path is the workable one.
 */

import { BridgeOnlyConnector, type ConnectorDefinition } from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'Apple Screen Time runs only on a worker advertising capability "screentime" (Lobu for Mac with Full Disk Access).';

export default class AppleScreenTimeConnector extends BridgeOnlyConnector {
  constructor() {
    super(BRIDGE_ONLY);
  }

  readonly definition: ConnectorDefinition = {
    key: 'apple.screen_time',
    name: 'Apple Screen Time',
    description:
      'Daily per-app usage totals from Lobu for Mac, sourced from the Apple Knowledge store. Captures both Mac usage and (if Screen Time iCloud sync is on) the user\'s iOS device usage.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'screentime',
    runtime: { platforms: ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      daily_app_usage: {
        key: 'daily_app_usage',
        name: 'Daily app usage',
        description:
          'Per-day total foreground time for each application (identified by bundle id).',
        configSchema: {
          type: 'object',
          properties: {
            backfill_days: {
              type: 'integer',
              minimum: 1,
              maximum: 90,
              default: 14,
              description: 'How many days the bridge should backfill on each sync.',
            },
          },
        },
        eventKinds: {
          screen_time_daily_app: {
            description: 'Total time the user spent in one application on a given day.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'date', 'bundle_id', 'seconds'],
              properties: {
                source: { type: 'string', const: 'apple_screen_time' },
                origin_id: { type: 'string' },
                date: { type: 'string', format: 'date' },
                bundle_id: { type: 'string' },
                seconds: { type: 'number', minimum: 0 },
              },
            },
          },
        },
      },
    },
  };
}

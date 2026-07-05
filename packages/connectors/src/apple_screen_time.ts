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
      'Daily per-app usage totals and focus-switch counts from Lobu for Mac, sourced from the Apple Knowledge store. Captures both Mac usage and (if Screen Time iCloud sync is on) the user\'s iOS device usage.',
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
      daily_app_focus_switches: {
        key: 'daily_app_focus_switches',
        name: 'Daily app focus switches',
        description:
          'Number of times each application (by bundle id) was brought to the foreground on a given day. Complements daily_app_usage: two hours in Slack as one long session vs. forty short switches are very different focus patterns, and only the switch count distinguishes them. Sourced from the same knowledgeC.db /app/inFocus stream.',
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
          app_focus_switches_daily: {
            description:
              'Number of times the user switched into one application on a given day.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'date', 'bundle_id', 'switches'],
              properties: {
                source: { type: 'string', const: 'apple_screen_time' },
                origin_id: { type: 'string' },
                date: { type: 'string', format: 'date' },
                bundle_id: { type: 'string' },
                switches: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
      live_app_focus: {
        key: 'live_app_focus',
        name: 'Live app focus',
        description:
          'Real-time app-focus transitions captured by the Mac menubar app via NSWorkspace.didActivateApplication, drained on each poll. Same event shape as daily_app_focus_switches but sub-second-latency observations rather than a retrospective knowledgeC.db pull. Source is tagged apple_screen_time_live so the two can be told apart.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          app_focus_switches_daily: {
            description:
              'Number of times the user switched into one application on a given day (live observation).',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'date', 'bundle_id', 'switches'],
              properties: {
                source: { type: 'string' },
                origin_id: { type: 'string' },
                date: { type: 'string', format: 'date' },
                bundle_id: { type: 'string' },
                switches: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
    },
  };
}

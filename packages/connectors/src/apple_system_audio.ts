/**
 * System Audio (meeting) Connector — Lobu for Mac only.
 *
 * Lobu for Mac captures system audio via ScreenCaptureKit (user-triggered
 * "Record meeting") into short AAC segments and ships each finalized segment
 * as an audio attachment under this connector's `recordings` feed. The
 * gateway's inline-attachment TranscriptionService turns each segment into a
 * transcript (same path WhatsApp voice notes use) — the placeholder
 * `[meeting audio]` payload is superseded by the transcribed text.
 *
 * Audio bytes are captured + held on the device; only the (capped) segment
 * attachments leave it, and recording only happens while the user has it on.
 */

import { BridgeOnlyConnector, type ConnectorDefinition } from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'apple.system_audio runs only on a worker advertising capability "system_audio" (Lobu for Mac with Screen Recording access).';

export default class AppleSystemAudioConnector extends BridgeOnlyConnector {
  constructor() {
    super(BRIDGE_ONLY);
  }

  readonly definition: ConnectorDefinition = {
    key: 'apple.system_audio',
    name: 'Meeting Audio',
    description:
      'Record system audio (meetings) on this Mac via Lobu for Mac and transcribe it. Audio is captured on the device; only short segments are shipped, and only while recording is on.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'system_audio',
    runtime: { platforms: ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      recordings: {
        key: 'recordings',
        name: 'Recordings',
        description: 'System-audio segments captured while recording; transcribed server-side.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          recording: {
            description: 'A single captured audio segment (transcribed after ingest).',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id'],
              properties: {
                source: { type: 'string', const: 'system_audio' },
                origin_id: { type: 'string' },
                filename: { type: 'string' },
                size_bytes: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  };
}

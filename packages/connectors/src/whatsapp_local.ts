/**
 * WhatsApp (local) Connector — Lobu for Mac only.
 *
 * Reads messages directly from the WhatsApp Desktop app's local SQLite store
 * at `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/
 * ChatStorage.sqlite`. Lobu for Mac snapshots the DB read-only, walks new
 * rows since the last `Z_PK` checkpoint, and emits events that share the
 * `whatsapp` connector's metadata shape so downstream entity links work
 * identically.
 *
 * Differences from the QR-paired `whatsapp` connector:
 *   - No Baileys, no socket, no phone-offline auto-unlink (WA Desktop itself
 *     is the linked device).
 *   - Ciphertext never leaves the Mac.
 *   - Bound to one specific Mac; requires WhatsApp Desktop installed.
 */

import {
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  IDENTITY,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'WhatsApp (local) runs only on a worker advertising capability "whatsapp_local" (Lobu for Mac with WhatsApp Desktop installed).';

export default class WhatsAppLocalConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'whatsapp.local',
    name: 'WhatsApp (this Mac)',
    description:
      "Reads messages from the WhatsApp Desktop app's local archive on this Mac. No QR pairing, no phone-offline auto-unlink — the desktop app is itself the linked device.",
    version: '0.1.0',
    faviconDomain: 'whatsapp.com',
    requiredCapability: 'whatsapp_local',
    runtime: { platforms: ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      messages: {
        key: 'messages',
        name: 'Messages',
        description:
          'Personal WhatsApp messages from 1:1 and group chats, sourced from WhatsApp Desktop.',
        configSchema: {
          type: 'object',
          properties: {
            chat_filter: {
              type: 'string',
              enum: ['all', 'individual', 'group'],
              default: 'all',
              description: 'Which chats to include.',
            },
            max_messages_per_sync: {
              type: 'integer',
              minimum: 1,
              maximum: 500000,
              default: 5000,
              description:
                'Safety cap on messages collected per sync. The first sync drains all messages up to this cap; subsequent syncs ingest only new messages, so the cap rarely binds.',
            },
          },
        },
        eventKinds: {
          message: {
            description: 'A WhatsApp message (text, caption, or system).',
            metadataSchema: {
              type: 'object',
              properties: {
                source: { type: 'string', const: 'whatsapp_local' },
                chat_jid: { type: 'string' },
                is_group: { type: 'boolean' },
                from_me: { type: 'boolean' },
                participant: { type: 'string' },
                sender_jid: { type: 'string' },
                sender_phone: { type: 'string' },
                push_name: { type: 'string' },
                media_type: { type: 'string' },
                quoted_id: { type: 'string' },
                is_forwarded: { type: 'boolean' },
                is_starred: { type: 'boolean' },
                is_system_event: { type: 'boolean' },
                voice_note_skipped: {
                  type: 'string',
                  enum: ['not_downloaded', 'too_large', 'empty', 'read_error', 'invalid_path'],
                },
              },
            },
            entityLinks: [
              {
                entityType: '$member',
                autoCreate: true,
                titlePath: 'metadata.push_name',
                identities: [
                  { namespace: IDENTITY.WA_JID, eventPath: 'metadata.sender_jid' },
                  { namespace: IDENTITY.PHONE, eventPath: 'metadata.sender_phone' },
                ],
                traits: {
                  push_name: {
                    eventPath: 'metadata.push_name',
                    behavior: 'prefer_non_empty',
                  },
                  last_seen_at: {
                    eventPath: 'occurred_at',
                    behavior: 'overwrite',
                  },
                },
              },
            ],
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

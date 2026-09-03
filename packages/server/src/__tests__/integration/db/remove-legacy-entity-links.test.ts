import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const MIGRATION = '20260723010000_remove_legacy_entity_links.sql';

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

interface Captured {
  convertedKind: Record<string, unknown>;
  currentKind: Record<string, unknown>;
  storedManifestKeys: string[];
  lingeringDefinitions: number;
  lingeringManifests: number;
}

class Rollback extends Error {}

describe('removed entityLinks migration', () => {
  let captured: Captured;

  beforeAll(async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    const sql = getDb();
    const upSection = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);
    const legacyRule = {
      entityType: 'person',
      autoCreate: true,
      createWhen: { path: 'metadata.is_group', equals: false },
      titlePath: 'metadata.push_name',
      identities: [{ namespace: 'wa_jid', eventPath: 'metadata.sender_jid' }],
      traits: {
        push_name: { eventPath: 'metadata.push_name', mergeStrategy: 'prefer_non_empty' },
      },
    };
    const currentAttribution = {
      role: 'about',
      autoCreate: false,
      target: {
        entityType: 'person',
        identities: [{ namespace: 'email', eventPath: 'metadata.email' }],
      },
    };

    const result: Captured = {
      convertedKind: {},
      currentKind: {},
      storedManifestKeys: [],
      lingeringDefinitions: -1,
      lingeringManifests: -1,
    };

    try {
      await sql.begin(async (tx: typeof sql) => {
        await tx`
          INSERT INTO connector_definitions
            (organization_id, key, name, version, auth_schema, feeds_schema, status)
          VALUES
            (
              ${org.id}, 'legacy-device', 'Legacy device', '0.1.0',
              ${tx.json({ methods: [{ type: 'none' }] })},
              ${tx.json({
                messages: {
                  eventKinds: {
                    message: {
                      metadataSchema: {
                        type: 'object',
                        properties: { reply_to: { type: ['string', 'null'], default: null } },
                      },
                      entityLinks: [legacyRule],
                    },
                  },
                },
              })},
              'active'
            ),
            (
              ${org.id}, 'mixed-device', 'Mixed device', '0.2.0',
              ${tx.json({ methods: [{ type: 'none' }] })},
              ${tx.json({
                messages: {
                  eventKinds: {
                    message: {
                      entityLinks: [legacyRule],
                      attributions: [currentAttribution],
                    },
                  },
                },
              })},
              'active'
            ),
            (
              ${org.id}, 'malformed-device', 'Malformed device', '0.1.0',
              ${tx.json({ methods: [{ type: 'none' }] })},
              ${tx.json({
                messages: { eventKinds: { message: { entityLinks: { invalid: true } } } },
              })},
              'active'
            )
        `;

        await tx`
          INSERT INTO device_workers
            (user_id, worker_id, platform, app_version, capabilities, label, organization_id, connector_manifests)
          VALUES (
            ${user.id}, 'removed-entity-links-test', 'macos', '1.0.0',
            ${tx.json(['local_directory'])}, 'Migration test', ${org.id},
            ${tx.json({
              legacy: {
                manifest_hash: 'legacy',
                received_at: '2026-07-23T00:00:00.000Z',
                manifest: {
                  key: 'legacy-device',
                  feeds_schema: {
                    messages: { eventKinds: { message: { entityLinks: [legacyRule] } } },
                  },
                },
              },
              current: {
                manifest_hash: 'current',
                received_at: '2026-07-23T00:00:00.000Z',
                manifest: {
                  key: 'current-device',
                  feeds_schema: {
                    messages: {
                      eventKinds: { message: { attributions: [currentAttribution] } },
                    },
                  },
                },
              },
              malformed: {
                manifest_hash: 'malformed',
                received_at: '2026-07-23T00:00:00.000Z',
                manifest: {
                  key: 'malformed-device',
                  feeds_schema: {
                    messages: {
                      eventKinds: { message: { entityLinks: { invalid: true } } },
                    },
                  },
                },
              },
            })}
          )
        `;

        await tx.unsafe(upSection);

        const definitions = await tx<{ key: string; feeds_schema: Record<string, unknown> }[]>`
          SELECT key, feeds_schema
          FROM connector_definitions
          WHERE organization_id = ${org.id}
            AND key IN ('legacy-device', 'mixed-device')
          ORDER BY key
        `;
        const byKey = new Map(definitions.map((row) => [row.key, row.feeds_schema]));
        result.convertedKind = (
          byKey.get('legacy-device') as {
            messages: { eventKinds: { message: Record<string, unknown> } };
          }
        ).messages.eventKinds.message;
        result.currentKind = (
          byKey.get('mixed-device') as {
            messages: { eventKinds: { message: Record<string, unknown> } };
          }
        ).messages.eventKinds.message;

        const [device] = await tx<{ connector_manifests: Record<string, unknown> }[]>`
          SELECT connector_manifests
          FROM device_workers
          WHERE worker_id = 'removed-entity-links-test'
        `;
        result.storedManifestKeys = Object.keys(device.connector_manifests).sort();

        // A replay must be harmless and leave no removed contract in either store.
        await tx.unsafe(upSection);
        const [counts] = await tx<{ definitions: string; manifests: string }[]>`
          SELECT
            (SELECT count(*) FROM connector_definitions
              WHERE jsonb_path_exists(feeds_schema, '$.*.eventKinds.*.entityLinks'))::text AS definitions,
            (SELECT count(*) FROM device_workers
              WHERE jsonb_path_exists(
                connector_manifests,
                '$.*.manifest.feeds_schema.*.eventKinds.*.entityLinks'
              ))::text AS manifests
        `;
        result.lingeringDefinitions = Number(counts.definitions);
        result.lingeringManifests = Number(counts.manifests);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    captured = result;
  });

  it('converts removed rules into authored_by attributions', () => {
    expect(captured.convertedKind.entityLinks).toBeUndefined();
    expect(captured.convertedKind.metadataSchema).toEqual({
      type: 'object',
      properties: { reply_to: { type: ['string', 'null'], default: null } },
    });
    expect(captured.convertedKind.attributions).toEqual([
      {
        role: 'authored_by',
        autoCreate: true,
        target: {
          entityType: 'person',
          createWhen: { path: 'metadata.is_group', equals: false },
          titlePath: 'metadata.push_name',
          identities: [{ namespace: 'wa_jid', eventPath: 'metadata.sender_jid' }],
        },
        traits: {
          push_name: { eventPath: 'metadata.push_name', mergeStrategy: 'prefer_non_empty' },
        },
      },
    ]);
  });

  it('preserves current attributions when both fields coexist', () => {
    expect(captured.currentKind.entityLinks).toBeUndefined();
    expect(captured.currentKind.attributions).toEqual([
      {
        role: 'about',
        autoCreate: false,
        target: {
          entityType: 'person',
          identities: [{ namespace: 'email', eventPath: 'metadata.email' }],
        },
      },
    ]);
  });

  it('drops only stored manifests that advertise the removed contract', () => {
    expect(captured.storedManifestKeys).toEqual(['current']);
  });

  it('is idempotent and leaves no removed contract in either store', () => {
    expect(captured.lingeringDefinitions).toBe(0);
    expect(captured.lingeringManifests).toBe(0);
  });
});

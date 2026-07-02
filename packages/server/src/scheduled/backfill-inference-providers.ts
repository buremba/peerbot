/**
 * App-level backfill: seed `inference_providers` rows from the legacy
 * `agent_secrets` rows named `provider:<type>:apiKey`.
 *
 * NOT inlined into a migration file. The classifier-backfill outage
 * (project_classifier_backfill_migrate_outage) is the precedent: a data
 * backfill that INSERTs per-org rows belongs in an idempotent app-level task,
 * not a dbmate migration (a slow/failing inline UPDATE aborts the whole
 * migration Job and blocks the deploy). This runs as a scheduled task, so it
 * self-heals on the first tick after deploy and converges the fleet without an
 * operator step — same shape as `refresh-connector-definitions`.
 *
 * Multi-replica safe: single-claimant per tick via the runs-queue (the
 * scheduler's claim path), and the INSERT itself is
 * `ON CONFLICT (organization_id, slug) WHERE deleted_at IS NULL DO NOTHING`
 * so two pods (or two ticks) never double-create. The ciphertext is COPIED
 * verbatim from the legacy row into a NEW `<slug>-<id>` name (no re-encrypt),
 * so the new row and the old row hold the byte-identical secret and the
 * resolver cutover is a pure rename.
 *
 * `capabilities` is seeded EMPTY (`'{}'::jsonb`) — an absent modality block
 * means "fall back to today's static/hardcoded behavior", so every backfilled
 * org is byte-identical at cutover (no custom upstream, org-key resolution
 * unchanged).
 */

import { getDb } from '../db/client';
import logger from '../utils/logger';

// Legacy org-shared provider secret name: `provider:<type>:apiKey`.
const LEGACY_PROVIDER_SECRET_RE = /^provider:(.+):apiKey$/;

// inference_providers.slug format: ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export interface BackfillInferenceProvidersResult {
  scanned: number;
  created: number;
  skipped: number;
  invalidSlug: number;
}

/**
 * One idempotent pass: for every legacy `provider:<type>:apiKey` secret with no
 * matching live `inference_providers` row, create the row (id minted via the
 * identity sequence → row-unique `<slug>-<id>` keyref → copied ciphertext) in a
 * single transaction per legacy secret.
 */
export async function backfillInferenceProviders(): Promise<BackfillInferenceProvidersResult> {
  const sql = getDb();
  const result: BackfillInferenceProvidersResult = {
    scanned: 0,
    created: 0,
    skipped: 0,
    invalidSlug: 0,
  };

  // Candidate legacy secrets that don't yet have a live inference_providers row
  // for the same (org, slug). The slug = the `<type>` captured from the name.
  const candidates = (await sql`
    SELECT s.organization_id, s.name, s.ciphertext
    FROM agent_secrets s
    WHERE s.name LIKE 'provider:%:apiKey'
      AND NOT EXISTS (
        SELECT 1 FROM inference_providers p
        WHERE p.organization_id = s.organization_id
          AND p.slug = regexp_replace(s.name, '^provider:(.+):apiKey$', '\\1')
          AND p.deleted_at IS NULL
      )
  `) as Array<{
    organization_id: string;
    name: string;
    ciphertext: string;
  }>;

  for (const row of candidates) {
    result.scanned++;
    const match = LEGACY_PROVIDER_SECRET_RE.exec(row.name);
    const slug = match?.[1];
    if (!slug || !SLUG_RE.test(slug)) {
      // A legacy type that isn't a valid slug (uppercase, too long, etc.) —
      // can't be represented as an inference_providers row. Leave it for the
      // resolver's legacy path; count it so operators can see the gap.
      result.invalidSlug++;
      continue;
    }

    try {
      const created = await sql.begin(async (tx) => {
        // Mint the id up front so it can be embedded in api_key_ref.
        const idRows = (await tx`
          SELECT nextval(pg_get_serial_sequence('inference_providers', 'id')) AS id
        `) as Array<{ id: string | number }>;
        const id = Number(idRows[0]?.id);
        const secretName = `${slug}-${id}`;
        const apiKeyRef = `secret://${row.organization_id}/${secretName}`;

        // ON CONFLICT DO NOTHING against the live-slug unique index: if another
        // pod/tick raced us between the candidate scan and here, this inserts
        // zero rows and we bail without touching the vault.
        const inserted = (await tx`
          INSERT INTO inference_providers
            (id, organization_id, slug, kind, api_key_ref, capabilities)
          VALUES (
            ${id}, ${row.organization_id}, ${slug}, ${slug},
            ${apiKeyRef}, '{}'::jsonb
          )
          ON CONFLICT (organization_id, slug) WHERE (deleted_at IS NULL)
          DO NOTHING
          RETURNING id
        `) as Array<{ id: string | number }>;

        if (inserted.length === 0) {
          // Lost the race — the id we minted is simply skipped (identity gaps
          // are fine). No vault write.
          return false;
        }

        // Copy the ciphertext VERBATIM into the new row-unique name (no
        // re-encrypt — same bytes, so the new row holds the identical secret).
        await tx`
          INSERT INTO agent_secrets (organization_id, name, ciphertext, created_at, updated_at)
          VALUES (${row.organization_id}, ${secretName}, ${row.ciphertext}, now(), now())
          ON CONFLICT (organization_id, name)
          DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
        `;

        return true;
      });

      if (created) {
        result.created++;
      } else {
        result.skipped++;
      }
    } catch (error) {
      // A single org's failure must not abort the batch — log and continue so
      // the rest of the fleet still converges. The next tick retries this one.
      result.skipped++;
      logger.warn(
        {
          err: error,
          organization_id: row.organization_id,
          slug,
        },
        '[backfill-inference-providers] failed to backfill one provider',
      );
    }
  }

  return result;
}

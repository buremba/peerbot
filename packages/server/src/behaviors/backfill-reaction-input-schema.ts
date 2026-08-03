/**
 * One-off backfill: populate `behaviors.reaction_input_schema` for reactions that
 * predate the reaction-contract feature.
 *
 * A reaction declares its extraction contract as an exported `input` JSON Schema.
 * `set_reaction_script` extracts that schema (via the isolate) and stores it on
 * `behaviors.reaction_input_schema`, so the worker is told the exact shape and the
 * host validates `extracted_data` against it (complete_window). Reactions created
 * BEFORE this feature have `reaction_input_schema = NULL` until their script is
 * re-applied — they run free-form (host validation skips a null schema) until then.
 * This re-extracts the schema from each stored `reaction_script` and fills the
 * column, so existing reactions get their contract without a re-apply.
 *
 * `reaction_script` / `reaction_input_schema` live on `behaviors` and are written
 * group-wide by `behavior_group_id` (the same cascade set_reaction_script uses). So
 * one representative behavior per group with a NULL schema is re-extracted and the
 * whole group is UPDATEd. A reaction that declares no `input` legitimately resolves
 * to NULL again — re-processing it is a no-op, so the run is idempotent and only
 * ever fills a NULL column (never overwrites a populated one).
 *
 * The extractor loads the `isolated-vm` native addon (V8-only), so this runs under
 * the server's node runtime.
 */

import type { DbClient } from '../db/client';
import { extractReactionInputSchema } from './reaction-executor';

interface GroupRow {
  behavior_group_id: string;
  organization_id: string;
  reaction_script: string;
}

export interface BackfillReport {
  groups: number;
  filled: number;
  noInput: number;
}

/**
 * Fill `reaction_input_schema` for reaction groups that have a script but no stored
 * contract. With `execute: false` it only resolves what WOULD be written (dry-run).
 * Reuses the canonical extractor, so the result equals a re-apply.
 */
export async function backfillReactionInputSchema(opts: {
  db: DbClient;
  org?: string | null;
  execute: boolean;
  log?: (msg: string) => void;
}): Promise<BackfillReport> {
  const { db: sql, execute } = opts;
  const log = opts.log ?? (() => {});

  // One representative behavior per group that has a reaction but no contract yet.
  // The script is identical across a group (set_reaction_script cascades it), so
  // any member's script is correct.
  const groups = (await sql`
    SELECT DISTINCT ON (behavior_group_id)
      behavior_group_id, organization_id, reaction_script
    FROM behaviors
    WHERE reaction_script IS NOT NULL
      AND reaction_input_schema IS NULL
      ${opts.org ? sql`AND organization_id = ${opts.org}` : sql``}
    ORDER BY behavior_group_id, id ASC
  `) as unknown as GroupRow[];

  log(`Found ${groups.length} reaction group(s) with no stored input schema.`);

  let filled = 0;
  let noInput = 0;
  for (const g of groups) {
    const schema = await extractReactionInputSchema(g.reaction_script);
    if (!schema) {
      noInput++;
      log(`  group ${g.behavior_group_id} (org ${g.organization_id}): no \`input\` export — leaving NULL`);
      continue;
    }
    filled++;
    const keys = Object.keys((schema.properties as Record<string, unknown>) ?? {});
    log(
      `  group ${g.behavior_group_id} (org ${g.organization_id}): input schema [${keys.join(', ')}]` +
        (execute ? ' — writing' : ' — (dry-run)')
    );
    if (execute) {
      await sql`
        UPDATE behaviors
        SET reaction_input_schema = ${sql.json(schema)}
        WHERE behavior_group_id = ${g.behavior_group_id}
          AND reaction_input_schema IS NULL
      `;
    }
  }

  return { groups: groups.length, filled, noInput };
}

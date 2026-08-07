#!/usr/bin/env bun

/**
 * One-time adoption of `events.identity_ns` / `events.identity_key` for keyed
 * Behavior EVENT outputs (migration 20260806120000_events_identity_key).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * A keyed output declares `{ event: "voice_profile", key: ["channel","mode"] }`
 * and must keep exactly one live event per key. From this migration on,
 * insertEvent stamps the identity at write time and
 * idx_events_identity_root_behavior enforces one chain ROOT per key. Rows that
 * existed before carry NULL, so the first post-deploy run would probe by
 * identity, find nothing, insert a fresh root, and leave the old chain live —
 * manufacturing exactly the duplicate the index exists to prevent. This script
 * stamps them first.
 *
 * ─── Why not in the migration ────────────────────────────────────────────────
 * The key is computed by computeStableKey()/formatBehaviorEventIdentity()
 * (packages/server/src/utils/stable-keys.ts): base64url, per-scalar type tags,
 * a UTF-16 field-name budget, safe-integer canonicalisation, JS trim semantics.
 * Restating that in SQL means two implementations of one algorithm, and any
 * drift between them stamps a key no run can ever probe for — the exact failure
 * this adoption is meant to prevent, made silent. So the migration adds columns
 * only and adoption calls the real function.
 *
 * ─── Ordering contract ───────────────────────────────────────────────────────
 * Run to completion BEFORE any keyed Behavior runs on the new build. The unique
 * index may be in place already: it is empty while every identity_key is NULL,
 * and once populated a genuinely duplicated key surfaces as a 23505 naming the
 * offending row rather than as a whole-migration abort. That is the intended
 * failure mode — two live chains for one key is a data question, not something
 * this script should pick a winner for.
 *
 * ─── Exactly what it does ────────────────────────────────────────────────────
 * Reads the keyed EVENT outputs of every CURRENT Behavior version (historical
 * versions may declare a superseded key and would offer a second candidate
 * identity for the same row), then stamps every matching event — superseded
 * versions included, because identity belongs to the THING, not to one version
 * of it, and the index constrains roots, which are usually superseded.
 *
 * Rows whose metadata does not satisfy the key contract are SKIPPED, not
 * guessed: they stay NULL and therefore inert, exactly as they are today.
 *
 * ─── Safety ──────────────────────────────────────────────────────────────────
 *   - DRY-RUN by default; pass --execute to write.
 *   - Idempotent and resumable: only still-NULL rows are touched.
 *   - Batched autocommit updates; no long transaction, no lock buildup.
 *
 * DATABASE_URL must point at the target database.
 */

import { parseArgs as parseNodeArgs } from "node:util";
import { getDb } from "../packages/server/src/db/client";
import {
  BEHAVIOR_EVENT_IDENTITY_NS,
  computeStableKey,
  formatBehaviorEventIdentity,
} from "../packages/server/src/utils/stable-keys";

const { values: args } = parseNodeArgs({
  options: {
    execute: { type: "boolean", default: false },
    batch: { type: "string", default: "500" },
  },
});

const EXECUTE = Boolean(args.execute);
const BATCH = Math.max(50, Number(args.batch ?? 500));

type KeyedOutput = {
  organization_id: string;
  semantic_type: string;
  key_fields: string[];
};

type Candidate = {
  id: number;
  metadata: Record<string, unknown> | null;
};

async function main() {
  const sql = getDb();

  // Current versions only — a superseded declaration would offer a second
  // candidate identity for the same event.
  //
  // key_fields stays JSONB rather than text[]: the pool runs with
  // fetch_types:false, so a Postgres array arrives as the raw literal string
  // "{channel,mode}" while jsonb is parsed into a real JS array.
  const outputs = await sql<KeyedOutput>`
		SELECT DISTINCT
			w.organization_id,
			o.value ->> 'event' AS semantic_type,
			o.value -> 'key' AS key_fields
		FROM watchers w
		JOIN watcher_versions wv ON wv.id = w.current_version_id
		CROSS JOIN LATERAL jsonb_each(wv.outputs) o
		WHERE o.value ->> 'event' IS NOT NULL
		  AND jsonb_typeof(o.value -> 'key') = 'array'
	`;

  if (outputs.length === 0) {
    console.log("no keyed event outputs declared; nothing to do");
    await sql.end();
    return;
  }

  // Two Behaviors in one org keying the same semantic type differently is not
  // resolvable here: each claims a different identity for the same row, and
  // whichever won would leave the other probing for a key that does not exist.
  const byScope = new Map<string, KeyedOutput[]>();
  for (const output of outputs) {
    const scope = `${output.organization_id}::${output.semantic_type}`;
    byScope.set(scope, [...(byScope.get(scope) ?? []), output]);
  }
  const conflicts = [...byScope.entries()].filter(([, v]) => v.length > 1);
  if (conflicts.length > 0) {
    console.error(
      `conflicting key declarations for: ${conflicts.map(([k]) => k).join(", ")}`
    );
    console.error("reconcile the Behavior declarations before adopting.");
    process.exit(1);
  }

  console.log(
    `${outputs.length} keyed event output(s): ${outputs
      .map((o) => `${o.semantic_type}[${o.key_fields.join(",")}]`)
      .join(", ")}`
  );

  let stamped = 0;
  let skipped = 0;

  for (const output of outputs) {
    // Walk forward by id rather than re-reading "identity_key IS NULL". Skipped
    // rows stay NULL by design, so a NULL-only predicate would hand back the
    // same unrepresentable rows on every batch and never terminate.
    let cursor = 0;
    let outputStamped = 0;
    let outputSkipped = 0;

    for (;;) {
      const candidates = await sql<Candidate>`
				SELECT id, metadata
				FROM events
				WHERE organization_id = ${output.organization_id}
				  AND semantic_type = ${output.semantic_type}
				  AND identity_key IS NULL
				  AND id > ${cursor}
				ORDER BY id
				LIMIT ${BATCH}
			`;
      if (candidates.length === 0) break;
      cursor = candidates[candidates.length - 1].id;

      for (const row of candidates) {
        let identityKey: string;
        try {
          identityKey = formatBehaviorEventIdentity(
            output.semantic_type,
            computeStableKey(row.metadata ?? {}, output.key_fields)
          );
        } catch {
          // Metadata does not satisfy the key contract, so no run could ever
          // compute an identity for it either. Leave it NULL and inert.
          outputSkipped++;
          continue;
        }
        if (!EXECUTE) {
          outputStamped++;
          continue;
        }
        // One statement per row: a batched VALUES join buys nothing at this
        // scale and a 23505 here must name the row it collided on. Two live
        // chain roots for one key is a data question, not something this script
        // should pick a winner for.
        await sql`
					UPDATE events
					SET identity_ns  = ${BEHAVIOR_EVENT_IDENTITY_NS},
					    identity_key = ${identityKey}
					WHERE id = ${row.id} AND identity_key IS NULL
				`;
        outputStamped++;
      }
    }

    stamped += outputStamped;
    skipped += outputSkipped;
    console.log(
      `  ${output.semantic_type}[${output.key_fields.join(",")}]: ${
        EXECUTE ? "stamped" : "would stamp"
      } ${outputStamped}, skipped ${outputSkipped}`
    );
  }

  if (!EXECUTE) {
    console.log(
      `DRY-RUN: ${stamped} row(s) would be stamped, ${skipped} skipped. Pass --execute to adopt.`
    );
    await sql.end();
    return;
  }

  console.log(
    `done: ${stamped} stamped, ${skipped} skipped (metadata cannot satisfy the declared key)`
  );
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EMBEDDING_MODEL } from '../embeddings';

/**
 * The legacy-stamp backfill migration hard-codes the embedding model literal
 * (it cannot import TS). If DEFAULT_EMBEDDING_MODEL ever changes without the
 * migration's literal tracking it, legacy rows get stamped with the wrong model
 * and silently drop out of the model-scoped vector search — the exact
 * full-corpus recall regression #1069/#1080 fixed. Pin the two together.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/migrations');
const BACKFILL_MIGRATION = '20260526170000_backfill_legacy_embedding_model_stamp.sql';

describe('embedding model literal drift guard', () => {
  it('backfill migration stamps NULL rows with DEFAULT_EMBEDDING_MODEL', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, BACKFILL_MIGRATION), 'utf-8');
    const match = sql.match(/SET embedding_model = '([^']+)'/);
    expect(match, 'backfill UPDATE literal not found in migration').not.toBeNull();
    expect(match?.[1]).toBe(DEFAULT_EMBEDDING_MODEL);
  });
});

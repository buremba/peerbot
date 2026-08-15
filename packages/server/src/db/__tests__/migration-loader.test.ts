import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listMigrationFiles } from '../migration-loader';

describe('listMigrationFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'migration-loader-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed when two files share one schema_migrations version', () => {
    writeFileSync(path.join(dir, '20260803140000_automation_outputs.sql'), '');
    writeFileSync(path.join(dir, '20260803140000_mcp_client_id.sql'), '');

    expect(() => listMigrationFiles(dir)).toThrow(/duplicate migration version 20260803140000/i);
  });
});

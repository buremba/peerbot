import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

function extractMigrationUpSection(content: string): string {
  return (
    content
      .split('-- migrate:down')[0]
      // Strip the marker line including any dbmate options (e.g. `transaction:false`).
      .replace(/^-- migrate:up.*$/m, '')
      // Older local Postgres versions do not support this GUC from newer pg_dump output.
      .replace(/^SET transaction_timeout = 0;\s*$/gm, '')
      .trim()
  );
}

function extractMigrationDownSection(content: string, file: string): string {
  const [, down] = content.split(/^-- migrate:down.*$/m);
  if (!down?.trim()) throw new Error(`${file} has no down migration`);
  return down.trim();
}

export function loadMigrationUpSection(migrationsDir: string, file: string): string {
  const content = readFileSync(join(migrationsDir, file), 'utf-8');
  return extractMigrationUpSection(content);
}

export function loadMigrationDownSection(migrationsDir: string, file: string): string {
  const content = readFileSync(join(migrationsDir, file), 'utf-8');
  return extractMigrationDownSection(content, file);
}

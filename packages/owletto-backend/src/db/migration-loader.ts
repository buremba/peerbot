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
      .replace('-- migrate:up', '')
      // Older local Postgres versions do not support this GUC from newer pg_dump output.
      .replace(/^SET transaction_timeout = 0;\s*$/gm, '')
      .trim()
  );
}

export function loadMigrationUpSection(migrationsDir: string, file: string): string {
  const content = readFileSync(join(migrationsDir, file), 'utf-8');
  return extractMigrationUpSection(content);
}

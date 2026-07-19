import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

export type MigrationSection = {
  /** SQL body with the `-- migrate:up|down ...` marker line stripped. */
  sql: string;
  /**
   * Whether the section should run inside a single transaction.
   * `false` when the marker has `transaction:false` (CONCURRENTLY index builds).
   */
  transaction: boolean;
};

function parseTransactionOption(markerLine: string): boolean {
  // dbmate: `-- migrate:up transaction:false` (default true when omitted).
  return !/\btransaction\s*:\s*false\b/i.test(markerLine);
}

function extractMigrationUpSection(content: string): MigrationSection {
  const upMarker = content.match(/^--\s*migrate:up(.*)$/m);
  const transaction = parseTransactionOption(upMarker?.[0] ?? '-- migrate:up');
  const sql = content
    .split(/^--\s*migrate:down.*$/m)[0]
    // Strip the marker line including any dbmate options (e.g. `transaction:false`).
    .replace(/^--\s*migrate:up.*$/m, '')
    // Older local Postgres versions do not support this GUC from newer pg_dump output.
    .replace(/^SET transaction_timeout = 0;\s*$/gm, '')
    .trim();
  return { sql, transaction };
}

function extractMigrationDownSection(content: string, file: string): MigrationSection {
  const downMarker = content.match(/^--\s*migrate:down(.*)$/m);
  if (!downMarker) throw new Error(`${file} has no down migration`);
  const transaction = parseTransactionOption(downMarker[0]);
  const parts = content.split(/^--\s*migrate:down.*$/m);
  const down = parts[1];
  if (!down?.trim()) throw new Error(`${file} has no down migration`);
  return { sql: down.trim(), transaction };
}

export function loadMigrationUpSection(migrationsDir: string, file: string): string {
  return loadMigrationUp(migrationsDir, file).sql;
}

export function loadMigrationDownSection(migrationsDir: string, file: string): string {
  return loadMigrationDown(migrationsDir, file).sql;
}

export function loadMigrationUp(migrationsDir: string, file: string): MigrationSection {
  const content = readFileSync(join(migrationsDir, file), 'utf-8');
  return extractMigrationUpSection(content);
}

export function loadMigrationDown(migrationsDir: string, file: string): MigrationSection {
  const content = readFileSync(join(migrationsDir, file), 'utf-8');
  return extractMigrationDownSection(content, file);
}

/**
 * Split a migration SQL section into top-level statements for statement-at-a-time
 * execution. Required for `transaction:false` sections that mix a heal DO with
 * CREATE/DROP INDEX CONCURRENTLY: Postgres treats a multi-statement simple-query
 * batch as one implicit transaction, which CONCURRENTLY refuses.
 *
 * Respects dollar-quoted bodies (`$tag$...$tag$`) and single-quoted string
 * literals so semicolons inside DO/function bodies are not treated as splits.
 * SQL line (`--`) and block comments are preserved without scanning their
 * contents for statement boundaries.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = '';
  };

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // Line comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      current += chunk;
      i += chunk.length;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      current += chunk;
      i += chunk.length;
      continue;
    }

    // Dollar-quoted string: $tag$...$tag$ or $$...$$
    if (ch === '$') {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) {
          current += sql.slice(i);
          break;
        }
        current += sql.slice(i, close + tag.length);
        i = close + tag.length;
        continue;
      }
    }

    // Single-quoted string (SQL standard; '' escape)
    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < n) {
        current += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === ';') {
      pushCurrent();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  pushCurrent();
  return statements;
}

/**
 * Execute a migration section. When `transaction` is false, run each top-level
 * statement separately so CREATE/DROP INDEX CONCURRENTLY is not trapped inside
 * an implicit multi-statement transaction.
 */
export async function executeMigrationSection(
  exec: (statement: string) => Promise<unknown>,
  section: MigrationSection,
): Promise<void> {
  if (!section.sql.trim()) return;
  if (section.transaction) {
    await exec(section.sql);
    return;
  }
  for (const statement of splitSqlStatements(section.sql)) {
    await exec(statement);
  }
}

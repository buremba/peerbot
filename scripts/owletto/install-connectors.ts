/**
 * Install or refresh connector(s) in an organization by slug.
 *
 * Stores only the metadata row — compiled_code stays null and is re-compiled
 * on demand at runtime via resolveConnectorCode(). Matches the pattern used
 * by ensureConnectorInstalled so baileys-style bundles don't hit the UTF-8
 * null-byte limitation in postgres text columns.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/install-connectors.ts --org buremba --file connectors/whatsapp.ts
 */

import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getDb } from '../../packages/owletto-backend/src/db/client';
import { compileConnectorFromFile } from '../../packages/owletto-backend/src/utils/connector-catalog';
import { extractConnectorMetadata } from '../../packages/owletto-backend/src/utils/connector-compiler';
import { upsertConnectorDefinitionRecords } from '../../packages/owletto-backend/src/utils/connector-definition-install';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    file: { type: 'string', multiple: true },
    help: { type: 'boolean' },
  },
});

if (values.help || !values.org || !values.file?.length) {
  console.log(`
Install or refresh connector(s) in an organization.

Usage:
  pnpm tsx --env-file=.env scripts/install-connectors.ts --org <slug> --file <path>...

Options:
  --org     Organization slug (required)
  --file    Path to connector .ts file (repeatable)
`);
  process.exit(values.help ? 0 : 1);
}

const sql = getDb();

const orgRow = (await sql`
  SELECT id FROM organization WHERE slug = ${values.org} LIMIT 1
`) as Array<{ id: string }>;

if (orgRow.length === 0) {
  console.error(`Organization '${values.org}' not found.`);
  process.exit(1);
}
const organizationId = orgRow[0].id;

let hadFailure = false;

for (const file of values.file ?? []) {
  const absolutePath = resolve(process.cwd(), file);
  try {
    const compiledCode = await compileConnectorFromFile(absolutePath);
    const metadata = await extractConnectorMetadata(compiledCode);
    if (!metadata.key || !metadata.name || !metadata.version) {
      throw new Error('Connector must export key, name, and version.');
    }
    const { updated } = await upsertConnectorDefinitionRecords({
      sql,
      organizationId,
      metadata,
      versionRecord: {
        compiledCode: null,
        compiledCodeHash: null,
        sourceCode: null,
        sourcePath: basename(absolutePath),
      },
    });
    console.log(`✓ ${metadata.key} v${metadata.version} (${updated ? 'updated' : 'created'})`);
  } catch (err) {
    hadFailure = true;
    console.error(`✗ ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await sql.end();
process.exit(hadFailure ? 1 : 0);

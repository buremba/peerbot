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
 *   pnpm tsx --env-file=.env scripts/install-connectors.ts --org buremba --file connectors/whatsapp.ts --target-entity-type contact
 */

import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getDb } from '../../packages/server/src/db/client';
import { compileConnectorFromFile } from '../../packages/server/src/utils/connector-catalog';
import { extractConnectorMetadata } from '../../packages/server/src/utils/connector-compiler';
import { upsertConnectorDefinitionRecords } from '../../packages/server/src/utils/connector-definition-install';
import { applyEntityLinkOverrides } from '../../packages/server/src/utils/entity-link-overrides';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    file: { type: 'string', multiple: true },
    'target-entity-type': { type: 'string' },
    'entity-link-overrides': { type: 'string' },
    help: { type: 'boolean' },
  },
});

if (values.help || !values.org || !values.file?.length) {
  console.log(`
Install or refresh connector(s) in an organization.

Usage:
  pnpm tsx --env-file=.env scripts/install-connectors.ts --org <slug> --file <path>...

Options:
  --org                      Organization slug (required)
  --file                     Path to connector .ts file (repeatable)
  --target-entity-type       Entity type slug to retarget the connector's $member
                             entityLink rule to (e.g. "contact"). The type must
                             already exist in the org.
  --entity-link-overrides    Full JSON entity_link_overrides payload (advanced;
                             overrides --target-entity-type when both are set).
`);
  process.exit(values.help ? 0 : 1);
}

let parsedOverrides: Record<string, unknown> | null = null;
if (values['entity-link-overrides']) {
  try {
    parsedOverrides = JSON.parse(values['entity-link-overrides']) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `Invalid --entity-link-overrides JSON: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
} else if (values['target-entity-type']) {
  parsedOverrides = {
    $member: { retargetEntityType: values['target-entity-type'] },
  };
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

    if (parsedOverrides !== null) {
      const err = await applyEntityLinkOverrides(organizationId, metadata.key, parsedOverrides);
      if (err) throw new Error(err);
    }

    console.log(`✓ ${metadata.key} v${metadata.version} (${updated ? 'updated' : 'created'})`);
  } catch (err) {
    hadFailure = true;
    console.error(`✗ ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await sql.end();
process.exit(hadFailure ? 1 : 0);

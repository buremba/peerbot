/**
 * A connector's `agentTooling` declaration must survive the install path into
 * `connector_definitions.agent_tooling` — that column, not connector code, is
 * what the deployment resolver reads. Covers both the INSERT (first install)
 * and the active-UPDATE (upgrade) branches, plus removal on a later version.
 */

import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestOrganization } from '../../setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { upsertConnectorDefinitionRecords } from '../../../utils/connector-definition-install';
import type { ConnectorMetadata } from '../../../utils/connector-compiler';
import { parseAgentTooling } from '../../../gateway/agent-tooling/resolver';

const AGENT_TOOLING = {
  nix: { packages: ['gh'] },
  env: [{ name: 'GH_TOKEN', credential: 'lease' as const }],
  domains: ['api.github.com', 'github.com'],
};

function metadataFor(
  version: string,
  agentTooling: ConnectorMetadata['agentTooling']
): ConnectorMetadata {
  return {
    key: 'agent-tooling-probe',
    name: 'Agent Tooling Probe',
    version,
    authSchema: null,
    webhook: null,
    feeds: null,
    actions: null,
    automationEvents: null,
    optionsSchema: null,
    agentTooling,
  };
}

function versionRecordFor(version: string) {
  return {
    compiledCode: `// compiled ${version}`,
    compiledCodeHash: `hash-${version}`,
    compileConfigHash: COMPILE_CONFIG_HASH,
    sourceCode: `// source ${version}`,
    sourcePath: `agent-tooling-probe@${version}.ts`,
  };
}

async function install(
  orgId: string,
  version: string,
  agentTooling: ConnectorMetadata['agentTooling']
): Promise<void> {
  await upsertConnectorDefinitionRecords({
    sql: getTestDb(),
    organizationId: orgId,
    metadata: metadataFor(version, agentTooling),
    versionRecord: versionRecordFor(version),
    versionScope: 'organization',
  });
}

async function storedAgentTooling(orgId: string): Promise<unknown> {
  const rows = await getTestDb()`
    SELECT agent_tooling FROM connector_definitions
    WHERE organization_id = ${orgId} AND key = 'agent-tooling-probe' AND status = 'active'
  `;
  return rows[0]?.agent_tooling ?? null;
}

describe('agentTooling persistence', () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Agent Tooling Org' });
    orgId = org.id;
  });

  it('round-trips a declaration through install, upgrade, and removal', async () => {
    // INSERT branch.
    await install(orgId, '1.0.0', AGENT_TOOLING);
    expect(await storedAgentTooling(orgId)).toEqual(AGENT_TOOLING);
    // The stored shape is exactly what the resolver accepts — no adapter between
    // the install path and the read path.
    expect(parseAgentTooling(await storedAgentTooling(orgId))).toEqual(AGENT_TOOLING);

    // Active-UPDATE branch: an upgrade must carry the declaration forward.
    await install(orgId, '1.1.0', {
      ...AGENT_TOOLING,
      nix: { packages: ['gh', 'git'] },
    });
    expect(await storedAgentTooling(orgId)).toEqual({
      ...AGENT_TOOLING,
      nix: { packages: ['gh', 'git'] },
    });

    // A version that drops the declaration must clear the column, not keep a
    // stale contribution alive.
    await install(orgId, '1.2.0', null);
    expect(await storedAgentTooling(orgId)).toBeNull();
  });

  it('leaves the column NULL for a connector that declares nothing', async () => {
    const org = await createTestOrganization({ name: 'No Tooling Org' });
    await install(org.id, '1.0.0', undefined);
    expect(await storedAgentTooling(org.id)).toBeNull();
  });
});

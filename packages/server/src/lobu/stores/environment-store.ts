import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.js";
import { environmentSecretName } from "./provider-secrets.js";

/**
 * Persistence for provider-backed runtime environments (the `environments`
 * table). Built-in is synthetic and devices are virtual (`device_workers`), so
 * neither lives here — this store holds only sandbox-provider environments plus
 * the per-agent runtime resolution the token mint reads.
 */

export interface EnvironmentRow {
  id: string;
  organizationId: string;
  name: string;
  providerKind: string;
  scope: "org" | "private";
  ownerUserId: string | null;
  /** True once a credential has been written to the vault for this environment. */
  connected: boolean;
  config: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

function rowToEnvironment(row: Record<string, unknown>): EnvironmentRow {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    providerKind: String(row.provider_kind),
    scope: row.scope === "private" ? "private" : "org",
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    connected: row.credential_name != null,
    config: (row.config as Record<string, unknown>) ?? {},
    createdAt: row.created_at ? String(row.created_at) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

export async function listEnvironments(
  organizationId: string
): Promise<EnvironmentRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id, organization_id, name, provider_kind, scope, owner_user_id,
           credential_name, config, created_at, updated_at
    FROM environments
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
  `) as Array<Record<string, unknown>>;
  return rows.map(rowToEnvironment);
}

export async function createEnvironment(
  organizationId: string,
  input: {
    name: string;
    providerKind: string;
    scope?: "org" | "private";
    ownerUserId?: string | null;
  }
): Promise<EnvironmentRow> {
  const sql = getDb();
  const id = `env-${randomUUID()}`;
  const rows = (await sql`
    INSERT INTO environments (id, organization_id, name, provider_kind, scope, owner_user_id)
    VALUES (
      ${id}, ${organizationId}, ${input.name}, ${input.providerKind},
      ${input.scope ?? "org"}, ${input.ownerUserId ?? null}
    )
    RETURNING id, organization_id, name, provider_kind, scope, owner_user_id,
              credential_name, config, created_at, updated_at
  `) as Array<Record<string, unknown>>;
  return rowToEnvironment(rows[0]);
}

/** Mark an environment as credentialed (called after writing its vault keys). */
export async function setEnvironmentCredentialName(
  id: string,
  organizationId: string
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE environments
    SET credential_name = ${environmentSecretName(id, "")}, updated_at = now()
    WHERE id = ${id} AND organization_id = ${organizationId}
  `;
}

/**
 * Delete an environment and null out any agent pinned to it (so dependent
 * agents fall back to the default runtime). The vault credential rows are left
 * in place — credential lifecycle is independent of the row.
 */
export async function deleteEnvironment(
  id: string,
  organizationId: string
): Promise<boolean> {
  const sql = getDb();
  let deleted = false;
  await sql.begin(async (tx) => {
    const rows = (await tx`
      DELETE FROM environments
      WHERE id = ${id} AND organization_id = ${organizationId}
      RETURNING id
    `) as Array<{ id: string }>;
    deleted = rows.length > 0;
    if (deleted) {
      await tx`
        UPDATE agents
        SET environment_id = NULL
        WHERE environment_id = ${id} AND organization_id = ${organizationId}
      `;
    }
  });
  return deleted;
}

export async function getEnvironmentProviderKind(
  id: string,
  organizationId: string
): Promise<string | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT provider_kind
    FROM environments
    WHERE id = ${id} AND organization_id = ${organizationId}
    LIMIT 1
  `) as Array<{ provider_kind: string }>;
  return rows[0]?.provider_kind ?? null;
}

/**
 * Resolve an agent's selected environment to the runtime claims stamped into
 * its worker token. Returns `{}` for builtin/unset/unknown so the caller falls
 * back to the deployment-wide `LOBU_RUNTIME_PROVIDER` (or in-process just-bash).
 * One JOIN query on the dispatch path.
 */
export async function resolveAgentRuntimeSelection(
  agentId: string | undefined,
  organizationId: string | undefined
): Promise<{ runtimeProviderId?: string; environmentId?: string }> {
  if (!agentId || !organizationId) return {};
  const sql = getDb();
  const rows = (await sql`
    SELECT e.id AS environment_id, e.provider_kind
    FROM agents a
    JOIN environments e
      ON e.id = a.environment_id AND e.organization_id = a.organization_id
    WHERE a.id = ${agentId} AND a.organization_id = ${organizationId}
    LIMIT 1
  `) as Array<{ environment_id: string; provider_kind: string }>;
  const row = rows[0];
  if (!row) return {};
  return { runtimeProviderId: row.provider_kind, environmentId: row.environment_id };
}

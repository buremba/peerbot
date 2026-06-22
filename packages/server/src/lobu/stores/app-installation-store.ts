import { getDb } from "../../db/client.js";

/** Advisory-lock tag that serializes activation for one tenant tuple. */
function activeTenantLockTag(key: AppInstallationTenantKey): string {
  return `app_installations:active:${key.provider}:${key.providerInstance}:${key.providerAppId}:${key.externalTenantId}`;
}

/**
 * A generic, provider-agnostic app installation: the multi-tenant record of
 * "Lobu App <X> is installed into external tenant <Y>". One model spans GitHub
 * Apps (installation_id), Slack OAuth v2 (team_id), and Jira/Atlassian Connect
 * (cloudId) under a single routing + ownership contract.
 *
 * This is an org/tenant INSTALLATION resource, not an agent connection: one
 * installed tenant routes to many agents via channel bindings, so it has no
 * owning agent. Credentials live in `auth_profiles` (referenced by
 * `authProfileId`), never plaintext here; `metadata` carries provider-specific
 * tenant data (team_name, account login, site url, etc.).
 */
export type AppInstallationStatus =
  | "active"
  | "suspended"
  | "revoked"
  | "error"
  | "pending";

export interface AppInstallationRow {
  id: number;
  organizationId: string;
  /** 'github' | 'slack' | 'jira' */
  provider: string;
  /** 'cloud' | GHES host | atlassian site class */
  providerInstance: string;
  /** Which Lobu App. */
  providerAppId: string;
  /** installation_id / team_id / cloudId. */
  externalTenantId: string;
  /** Credential backing in `auth_profiles` (token / app-secret refs). */
  authProfileId: number | null;
  status: AppInstallationStatus;
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

/** The provider tenant tuple that identifies an installation for routing. */
export interface AppInstallationTenantKey {
  provider: string;
  providerInstance: string;
  providerAppId: string;
  externalTenantId: string;
}

/** Input for {@link AppInstallationStore.upsert}. */
export interface AppInstallationUpsert extends AppInstallationTenantKey {
  organizationId: string;
  authProfileId?: number | null;
  /** Defaults to 'active'. */
  status?: AppInstallationStatus;
  metadata?: Record<string, any>;
}

export interface AppInstallationStore {
  /**
   * Insert or update an installation, keyed on the provider tenant tuple
   * (provider, providerInstance, providerAppId, externalTenantId).
   *
   * Reject/transfer ownership: at most ONE active install may own a given
   * tenant tuple at a time.
   *  - Same-org reinstall (an active row for the tuple already owned by
   *    `organizationId`): updates that row in place.
   *  - Different-org install: TRANSFERS ownership — the prior active row is
   *    demoted (status -> 'suspended') and a new active row is inserted/
   *    activated, atomically in ONE transaction.
   *
   * Converges under concurrent callers across replicas: the work runs in a
   * transaction and the partial unique index `app_installations_active_tenant`
   * is the source of truth, so two callers racing to activate the same tuple
   * serialize on the index and resolve to a single active owner with no
   * in-memory coordination.
   */
  upsert(install: AppInstallationUpsert): Promise<AppInstallationRow>;

  /**
   * Resolve the active install for a tenant tuple. This is the shared webhook
   * router's lookup — the endpoint carries no org context, so it keys on the
   * tuple alone and returns the owning org + credential backing (or null).
   */
  resolveActiveByTenant(
    key: AppInstallationTenantKey
  ): Promise<AppInstallationRow | null>;

  getById(id: number): Promise<AppInstallationRow | null>;
  listByOrg(organizationId: string): Promise<AppInstallationRow[]>;
  setStatus(id: number, status: AppInstallationStatus): Promise<void>;
  /** Convenience for `setStatus(id, "revoked")`. */
  revoke(id: number): Promise<void>;
}

function rowToInstallation(row: Record<string, any>): AppInstallationRow {
  return {
    id: typeof row.id === "string" ? Number(row.id) : row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    providerInstance: row.provider_instance,
    providerAppId: row.provider_app_id,
    externalTenantId: row.external_tenant_id,
    authProfileId:
      row.auth_profile_id == null
        ? null
        : typeof row.auth_profile_id === "string"
          ? Number(row.auth_profile_id)
          : row.auth_profile_id,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.getTime()
        : (row.created_at ?? Date.now()),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : (row.updated_at ?? Date.now()),
  };
}

export function createPostgresAppInstallationStore(): AppInstallationStore {
  return {
    async upsert(install) {
      const sql = getDb();
      const status: AppInstallationStatus = install.status ?? "active";
      const authProfileId = install.authProfileId ?? null;
      const metadata = install.metadata ?? {};

      // A non-active upsert can't conflict on the partial unique index, so it
      // needs no transfer step: just record the row for the tuple+org.
      if (status !== "active") {
        const rows = await sql`
          INSERT INTO app_installations (
            organization_id, provider, provider_instance, provider_app_id,
            external_tenant_id, auth_profile_id, status, metadata, updated_at
          )
          VALUES (
            ${install.organizationId}, ${install.provider}, ${install.providerInstance},
            ${install.providerAppId}, ${install.externalTenantId}, ${authProfileId},
            ${status}, ${sql.json(metadata)}, now()
          )
          RETURNING *
        `;
        return rowToInstallation(rows[0]);
      }

      // Activating: do the reject/transfer atomically. A transaction-scoped
      // advisory lock keyed on the tenant tuple serializes ALL concurrent
      // activations for that tuple (across replicas — the lock lives in
      // Postgres, not memory), so the demote+activate is a single ordered step
      // and the partial unique index `app_installations_active_tenant` is never
      // contended. This is the convergence guarantee under N replicas, mirroring
      // the repo's pg_advisory_xact_lock pattern (auth/credentials.ts).
      return sql.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
          activeTenantLockTag(install),
        ]);

        // Demote any active row for this tuple owned by a DIFFERENT org — a
        // transfer takes the single active slot from the prior owner. (A same-org
        // active row is left as-is; it becomes the row we refresh below.) This is
        // a no-op when no different-org active row exists.
        await tx`
          UPDATE app_installations
          SET status = 'suspended', updated_at = now()
          WHERE provider = ${install.provider}
            AND provider_instance = ${install.providerInstance}
            AND provider_app_id = ${install.providerAppId}
            AND external_tenant_id = ${install.externalTenantId}
            AND status = 'active'
            AND organization_id <> ${install.organizationId}
        `;

        // Find an EXISTING row for the TARGET (org, tuple) — active or demoted —
        // so an install/reinstall/return-transfer REACTIVATES that single row in
        // place instead of inserting a duplicate. This is the invariant: at most
        // ONE row per (provider, tuple, org). Without it, an A->B->A transfer
        // would leave org A with two rows (the original demoted one + a fresh
        // active one), and listByOrg/list would return duplicate ids.
        const existingRows = await tx`
          SELECT * FROM app_installations
          WHERE provider = ${install.provider}
            AND provider_instance = ${install.providerInstance}
            AND provider_app_id = ${install.providerAppId}
            AND external_tenant_id = ${install.externalTenantId}
            AND organization_id = ${install.organizationId}
          ORDER BY (status = 'active') DESC, updated_at DESC, id DESC
          LIMIT 1
        `;
        const existing = existingRows[0];

        if (existing) {
          // Reactivate-and-refresh the target org's existing row in place (covers
          // same-org reinstall AND a return transfer A->B->A: org A's demoted row
          // is reused, not duplicated).
          const rows = await tx`
            UPDATE app_installations
            SET status = 'active',
                auth_profile_id = ${authProfileId},
                metadata = ${sql.json(metadata)},
                updated_at = now()
            WHERE id = ${existing.id}
            RETURNING *
          `;
          return rowToInstallation(rows[0]);
        }

        // First install for this (org, tuple): insert the active row.
        const rows = await tx`
          INSERT INTO app_installations (
            organization_id, provider, provider_instance, provider_app_id,
            external_tenant_id, auth_profile_id, status, metadata, updated_at
          )
          VALUES (
            ${install.organizationId}, ${install.provider}, ${install.providerInstance},
            ${install.providerAppId}, ${install.externalTenantId}, ${authProfileId},
            'active', ${sql.json(metadata)}, now()
          )
          RETURNING *
        `;
        return rowToInstallation(rows[0]);
      });
    },

    async resolveActiveByTenant(key) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM app_installations
        WHERE provider = ${key.provider}
          AND provider_instance = ${key.providerInstance}
          AND provider_app_id = ${key.providerAppId}
          AND external_tenant_id = ${key.externalTenantId}
          AND status = 'active'
        LIMIT 1
      `;
      return rows.length ? rowToInstallation(rows[0]) : null;
    },

    async getById(id) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM app_installations WHERE id = ${id} LIMIT 1
      `;
      return rows.length ? rowToInstallation(rows[0]) : null;
    },

    async listByOrg(organizationId) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM app_installations
        WHERE organization_id = ${organizationId}
        ORDER BY created_at DESC, id DESC
      `;
      return rows.map(rowToInstallation);
    },

    async setStatus(id, status) {
      const sql = getDb();
      await sql`
        UPDATE app_installations
        SET status = ${status}, updated_at = now()
        WHERE id = ${id}
      `;
    },

    async revoke(id) {
      await this.setStatus(id, "revoked");
    },
  };
}

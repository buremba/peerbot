import { getDb, tsTime } from "../../db/client.js";

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
  /**
   * Metadata keys whose value on an EXISTING active row (same provider tuple +
   * org) must be PRESERVED on an in-place update — the existing value wins over
   * the one in `metadata`. This is the race-safe id-claim primitive: a caller
   * that mints a durable id (e.g. Slack's `external_id`) outside the upsert and
   * loses the insert race reads back the WINNER's id instead of overwriting it,
   * so concurrent callers for the same tuple converge on ONE id (and one
   * downstream secret) rather than minting duplicates. Applied INSIDE the
   * advisory-locked transaction, so the preserve-or-mint decision is atomic per
   * tuple across replicas. Keys absent on the existing row fall through to the
   * provided `metadata` value (the first writer's mint is kept).
   */
  preserveMetadataKeysOnUpdate?: string[];
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

  /**
   * Resolve the SOLE active install for a provider app whose `metadata[key]`
   * (a JSONB key, not a column) equals `value` — but ONLY when the match is
   * unambiguous. Returns the row when exactly one active install matches; null
   * when none OR when two-or-more match (the caller must not guess between them).
   *
   * Generic, provider-neutral: no Slack/Grid concepts here. Its first consumer is
   * Slack's Enterprise Grid fallback — a Grid enterprise can host many workspaces
   * each with its own install, so an event's `enterprise_id` only identifies an
   * install when the enterprise has exactly one (see `getSlackInstallByEnterpriseId`).
   */
  resolveSoleActiveByMetadata(
    provider: string,
    providerAppId: string,
    key: string,
    value: string
  ): Promise<AppInstallationRow | null>;

  /**
   * Resolve the SOLE active install for a provider app whose `metadata[key]`
   * equals `value` AND whose `metadata[flagKey]` is boolean `true` — unambiguous
   * only. Distinct from {@link resolveSoleActiveByMetadata}: it filters to rows
   * carrying a truthy flag, so a match survives even when OTHER (non-flagged)
   * installs share the same `value`.
   *
   * Its Slack consumer routes a Grid ORG-WIDE install (`is_enterprise_install`)
   * by `enterprise_id`: Slack allows exactly one org-wide install per enterprise,
   * so this is unambiguous EVEN WHEN per-workspace installs of sibling teams also
   * exist under the same enterprise — which is precisely the case
   * {@link resolveSoleActiveByMetadata} could not handle (it saw 2+ and gave up).
   * Returns null when none match or, defensively, when 2+ flagged rows match.
   */
  resolveActiveByMetadataFlag(
    provider: string,
    providerAppId: string,
    key: string,
    value: string,
    flagKey: string
  ): Promise<AppInstallationRow | null>;

  getById(id: number): Promise<AppInstallationRow | null>;
  listByOrg(organizationId: string): Promise<AppInstallationRow[]>;
  setStatus(id: number, status: AppInstallationStatus): Promise<void>;
  /** Convenience for `setStatus(id, "revoked")`. */
  revoke(id: number): Promise<void>;

  /**
   * Resolve an install by a provider-stable EXTERNAL id stamped in
   * `metadata.external_id`, scoped to `provider`. Some providers route by a
   * durable string id distinct from the bigint PK — e.g. Slack keeps a stable
   * `slackinst-<uuid>` id (it is the secret-store name prefix
   * `installations/<id>/botToken` AND the chat-instance-manager memo / webhook
   * routing key, so it must survive reinstalls and the bigint PK can't serve as
   * it). Prefers the active row, then most-recent. Null when none match.
   */
  resolveByExternalId(
    provider: string,
    externalId: string
  ): Promise<AppInstallationRow | null>;

  /** All installs for a provider within an org, newest first. */
  listByProviderAndOrg(
    provider: string,
    organizationId: string
  ): Promise<AppInstallationRow[]>;

  /** Set status on the install carrying `(provider, metadata.external_id)`. */
  setStatusByExternalId(
    provider: string,
    externalId: string,
    status: AppInstallationStatus
  ): Promise<void>;

  /** Delete the install carrying `(provider, metadata.external_id)`. */
  deleteByExternalId(provider: string, externalId: string): Promise<void>;

  /**
   * Read-only resolve of the single install row for a given tenant tuple owned
   * by `organizationId` (active or demoted), preferring the active row then the
   * most recent. No side effects — callers use it to learn an existing row's
   * durable `external_id` BEFORE doing side-effecting work (e.g. persisting a
   * token under that id), so a later failure can't leave a half-activated row.
   * Null when this org has no row for the tuple.
   */
  getByTenantAndOrg(
    key: AppInstallationTenantKey,
    organizationId: string
  ): Promise<AppInstallationRow | null>;
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
      tsTime(row.created_at),
    updatedAt:
      tsTime(row.updated_at),
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
          // is reused, not duplicated). Merge any preserve-requested metadata keys
          // from the existing row (their value wins over the incoming one) — the
          // race-safe durable-id claim: a caller that minted its own id but lost
          // the insert race reads back the winner's id instead of clobbering it.
          const mergedMetadata = { ...metadata };
          const existingMetadata =
            (existing.metadata as Record<string, any> | null) ?? {};
          for (const key of install.preserveMetadataKeysOnUpdate ?? []) {
            if (existingMetadata[key] !== undefined) {
              mergedMetadata[key] = existingMetadata[key];
            }
          }
          const rows = await tx`
            UPDATE app_installations
            SET status = 'active',
                auth_profile_id = ${authProfileId},
                metadata = ${sql.json(mergedMetadata)},
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

    async resolveSoleActiveByMetadata(provider, providerAppId, key, value) {
      const sql = getDb();
      // Only resolve when UNAMBIGUOUS: exactly one active install matches. Two+ ⇒
      // null so the caller drops rather than guess (e.g. a Grid enterprise with
      // multiple installs). `key` is bound as the `->>` text operand, not spliced
      // into SQL. LIMIT 2 is enough to detect ambiguity.
      const rows = await sql`
        SELECT * FROM app_installations
        WHERE provider = ${provider}
          AND provider_app_id = ${providerAppId}
          AND status = 'active'
          AND metadata ->> ${key} = ${value}
        LIMIT 2
      `;
      return rows.length === 1 ? rowToInstallation(rows[0]) : null;
    },

    async resolveActiveByMetadataFlag(provider, providerAppId, key, value, flagKey) {
      const sql = getDb();
      // Match active installs where metadata[key] = value AND metadata[flagKey]
      // is JSON boolean true. `key`/`flagKey` are bound as `->>` / `->` operands,
      // never spliced into SQL. LIMIT 2 detects (defensively) an impossible
      // duplicate org-wide install; Slack guarantees at most one per enterprise.
      const rows = await sql`
        SELECT * FROM app_installations
        WHERE provider = ${provider}
          AND provider_app_id = ${providerAppId}
          AND status = 'active'
          AND metadata ->> ${key} = ${value}
          AND (metadata -> ${flagKey}) = 'true'::jsonb
        LIMIT 2
      `;
      return rows.length === 1 ? rowToInstallation(rows[0]) : null;
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

    async resolveByExternalId(provider, externalId) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM app_installations
        WHERE provider = ${provider}
          AND metadata ->> 'external_id' = ${externalId}
        ORDER BY (status = 'active') DESC, updated_at DESC, id DESC
        LIMIT 1
      `;
      return rows.length ? rowToInstallation(rows[0]) : null;
    },

    async listByProviderAndOrg(provider, organizationId) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM app_installations
        WHERE provider = ${provider}
          AND organization_id = ${organizationId}
        ORDER BY created_at DESC, id DESC
      `;
      return rows.map(rowToInstallation);
    },

    async setStatusByExternalId(provider, externalId, status) {
      const sql = getDb();
      await sql`
        UPDATE app_installations
        SET status = ${status}, updated_at = now()
        WHERE provider = ${provider}
          AND metadata ->> 'external_id' = ${externalId}
      `;
    },

    async deleteByExternalId(provider, externalId) {
      const sql = getDb();
      await sql`
        DELETE FROM app_installations
        WHERE provider = ${provider}
          AND metadata ->> 'external_id' = ${externalId}
      `;
    },

    async getByTenantAndOrg(key, organizationId) {
      const sql = getDb();
      const rows = await sql`
        SELECT * FROM app_installations
        WHERE provider = ${key.provider}
          AND provider_instance = ${key.providerInstance}
          AND provider_app_id = ${key.providerAppId}
          AND external_tenant_id = ${key.externalTenantId}
          AND organization_id = ${organizationId}
        ORDER BY (status = 'active') DESC, updated_at DESC, id DESC
        LIMIT 1
      `;
      return rows.length ? rowToInstallation(rows[0]) : null;
    },
  };
}

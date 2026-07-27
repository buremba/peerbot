/**
 * Credential-at-rest handling for `auth_profiles.auth_data`.
 *
 * `auth_data` on an `env` profile holds bearer credentials — a postgres DSN
 * carries its own password, so whoever reads the column owns the database.
 * Historically the column stored those values verbatim, which put a live
 * credential in plaintext in a row that several read paths select wholesale.
 *
 * Values are now stored as `secret://` refs. The ref points at
 * `agent_secrets`, whose store already encrypts with AES-256-GCM and scopes
 * rows per organization — the same mechanism Slack bot tokens and webhook
 * secrets use. Reusing it (rather than encrypting the JSONB value inline)
 * means one key-management story, one rotation story, and it composes with
 * the redaction layer, which already treats a `secret://` ref as non-secret
 * to echo.
 *
 * Only `env`-kind profiles are converted. `browser_session` / `interactive`
 * profiles hold structured session state (cookie jars, Baileys creds), not
 * flat credential strings; they are out of scope here and untouched.
 */

import { parseSecretRef } from "@lobu/core";
import { type DbClient, getDb } from "../db/client";
import { PostgresSecretStore } from "../lobu/stores/postgres-secret-store";
import { orgContext } from "../lobu/stores/org-context";
import {
	resolveSecretValue,
	type SecretStore,
	type WritableSecretStore,
} from "../gateway/secrets/index.js";
import { createLogger } from "@lobu/core";
import { normalizeAuthValues } from "./auth-profiles";

const logger = createLogger("auth-credential-secrets");

/** Scheme of the builtin (`agent_secrets`-backed) store. */
const BUILTIN_SECRET_SCHEME = "secret";

/**
 * True only for a ref into the builtin secret store.
 *
 * Deliberately NOT `isSecretRef` from @lobu/core: that matches ANY
 * `scheme://…` URI, so a `postgres://user:pass@host/db` DSN — exactly the
 * credential this module exists to protect — parses as an "already stored
 * ref" and would be passed through verbatim, leaving the password in
 * plaintext. The scheme must be checked explicitly.
 */
function isStoredSecretRef(value: string): boolean {
	return parseSecretRef(value)?.scheme === BUILTIN_SECRET_SCHEME;
}

/**
 * Secret name for one credential field. Namespaced per auth profile so two
 * profiles holding a `DATABASE_URL` never collide.
 */
function authCredentialSecretName(
	authProfileId: number,
	key: string,
	namespace?: "legacy-convergence",
): string {
	return namespace
		? `auth-profile/${authProfileId}/${namespace}/${key}`
		: `auth-profile/${authProfileId}/${key}`;
}

type SecretRefAuthDataParams = {
	organizationId: string;
	authProfileId: number;
	credentials: Record<string, unknown>;
	secretStore?: WritableSecretStore;
};

async function storeAuthCredentialRefs(
	params: SecretRefAuthDataParams,
	namespace?: "legacy-convergence",
): Promise<Record<string, string>> {
	const store = params.secretStore ?? new PostgresSecretStore();
	const values = normalizeAuthValues(params.credentials);
	const out: Record<string, string> = {};

	await orgContext.run({ organizationId: params.organizationId }, async () => {
		for (const [key, value] of Object.entries(values)) {
			// Already a builtin ref (e.g. a rename-only profile update): keep it
			// rather than re-storing the ref string as if it were a credential.
			if (isStoredSecretRef(value)) {
				out[key] = value;
				continue;
			}
			// `store.put` directly, NOT `persistSecretValue` — the latter skips
			// any value matching `isSecretRef`, which a `postgres://` DSN does.
			out[key] = await store.put(
				authCredentialSecretName(params.authProfileId, key, namespace),
				value,
			);
		}
	});

	return out;
}

/**
 * Convert a credential map into one safe to store in `auth_data`: every
 * value is written to the secret store and replaced by its `secret://` ref.
 *
 * The org is threaded EXPLICITLY rather than relying on the ambient
 * AsyncLocalStorage context. `PostgresSecretStore.put` silently falls back to
 * a deployment-wide GLOBAL bucket when no context is set, and a tenant
 * credential landing there would shadow every other org's read of the same
 * name. Worker-token paths (run completion) have no ambient org, so the
 * fallback would otherwise be reachable in production.
 */
export async function toSecretRefAuthData(
	params: SecretRefAuthDataParams,
): Promise<Record<string, string>> {
	return storeAuthCredentialRefs(params);
}

/**
 * Write a credential map onto an auth profile, storing only `secret://` refs.
 */
export async function persistAuthCredentials(params: {
	organizationId: string;
	authProfileId: number;
	credentials: Record<string, unknown>;
	secretStore?: WritableSecretStore;
	db?: DbClient;
}): Promise<Record<string, string>> {
	const refs = await toSecretRefAuthData(params);
	const sql = params.db ?? getDb();
	await sql`
    UPDATE auth_profiles
    SET auth_data = ${sql.json(refs)},
        updated_at = NOW()
    WHERE id = ${params.authProfileId}
      AND organization_id = ${params.organizationId}
  `;
	return refs;
}

/**
 * Resolve any `secret://` refs in an `env` profile's `auth_data` back to real
 * values, for handing to connector execution.
 *
 * A value that is not a ref is passed through: `auth_data` also carries
 * non-secret bookkeeping (`requested_scopes`, `granted_scopes`) that was never
 * secret-stored.
 */
export async function resolveAuthCredentials(params: {
	organizationId: string;
	authData: Record<string, unknown> | null | undefined;
	secretStore?: SecretStore;
}): Promise<Record<string, string>> {
	const values = normalizeAuthValues(params.authData ?? {});
	if (Object.keys(values).length === 0) return {};

	const store = params.secretStore ?? new PostgresSecretStore();
	const out: Record<string, string> = {};

	await orgContext.run({ organizationId: params.organizationId }, async () => {
		for (const [key, value] of Object.entries(values)) {
			if (!isStoredSecretRef(value)) {
				out[key] = value;
				continue;
			}
			const resolved = await resolveSecretValue(store, value);
			if (resolved === undefined) {
				// A dangling ref means the credential is gone. Drop the key rather
				// than passing the literal `secret://…` string to a connector,
				// which would surface as a confusing connect failure.
				logger.warn(
					{ key, auth_profile_ref: value },
					"Auth credential ref did not resolve",
				);
				continue;
			}
			out[key] = resolved;
		}
	});

	return out;
}

/**
 * One pass converting legacy plaintext `env` credentials into secret refs.
 *
 * Called by the scheduled convergence job. Kept in TS because the values must
 * pass through the encrypting secret store.
 */
export async function migrateLegacyPlaintextAuthData(): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
    SELECT id, organization_id, auth_data
    FROM auth_profiles
    WHERE profile_kind = 'env'
      AND auth_data IS NOT NULL
      AND auth_data <> '{}'::jsonb
  `) as unknown as Array<{
		id: number;
		organization_id: string;
		auth_data: Record<string, unknown> | null;
	}>;

	let converted = 0;
	for (const row of rows) {
		const values = normalizeAuthValues(row.auth_data ?? {});
		if (!Object.values(values).some((value) => !isStoredSecretRef(value))) {
			continue;
		}

		// Use a staging namespace rather than the live rotation names. If a user
		// rotates this profile after the scan but before the UPDATE below, a
		// losing convergence attempt must not overwrite the live secret value.
		const refs = await storeAuthCredentialRefs(
			{
				organizationId: row.organization_id,
				authProfileId: Number(row.id),
				credentials: values,
			},
			"legacy-convergence",
		);
		const updated = await sql`
      UPDATE auth_profiles
      SET auth_data = ${sql.json(refs)},
          updated_at = NOW()
      WHERE id = ${row.id}
        AND organization_id = ${row.organization_id}
        AND auth_data = ${sql.json(row.auth_data)}::jsonb
      RETURNING id
		`;
		if (updated.length > 0) converted += 1;
	}

	// Staging rows remain referenced after a successful conversion. Remove them
	// only after the profile has rotated to a live ref (or been deleted); this
	// also cleans up a staging write whose compare-and-swap lost a race.
	await sql`
    DELETE FROM agent_secrets staged
    WHERE staged.name LIKE 'auth-profile/%/legacy-convergence/%'
      AND NOT EXISTS (
        SELECT 1
        FROM auth_profiles profile
        WHERE profile.organization_id = staged.organization_id
          AND profile.id::text = split_part(staged.name, '/', 2)
          AND profile.auth_data::text LIKE '%legacy-convergence%'
      )
  `;

	return converted;
}

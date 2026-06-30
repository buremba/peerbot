/**
 * Org-shared provider credentials live in `agent_secrets` under a documented
 * naming convention so the worker's credential-resolution path and `lobu apply`
 * agree on where to read/write the same row.
 *
 * Resolution order (worker side, see base-provider-module.ts):
 *   1. Per-user `auth_profiles` (BYOK / personal OAuth)
 *   2. Org-shared `agent_secrets` row (this name) — declarative, set via
 *      `lobu apply` from `[[agents.<id>.providers]] key = "$VAR"`
 *   3. Deployment-wide `process.env` (operator's machine, last resort)
 *
 * The org-scoping is enforced by `(organization_id, name)` PK on the table;
 * no per-agent override exists today (the same key is used by every agent in
 * the org that calls this provider).
 */

import {
	createLogger,
	decrypt,
	encrypt,
	getErrorMessage,
} from "@lobu/core";
import { getDb } from "../../db/client.js";

const logger = createLogger("provider-secrets");

export function providerOrgSecretName(providerId: string): string {
  return `provider:${providerId}:apiKey`;
}

/**
 * Vault row name for one credential field of a runtime environment. Keyed by
 * `environments.id` (not provider kind) so two environments of the same
 * provider in one org keep distinct credentials — e.g.
 * `environment:env-abc:token`. Org-scoping is still enforced by the
 * `(organization_id, name)` PK on `agent_secrets`.
 */
export function environmentSecretName(
  environmentId: string,
  field: string
): string {
  return `environment:${environmentId}:${field}`;
}

/**
 * Encrypt + upsert one credential field for a runtime environment into the
 * org vault (`environment:<id>:<field>`). Used by the environments API; the
 * plaintext is never persisted and the gateway resolves it back via
 * {@link readEnvironmentSecret} at exec time.
 */
export async function writeEnvironmentSecret(
  environmentId: string,
  field: string,
  organizationId: string,
  value: string
): Promise<void> {
  const sql = getDb();
  const ciphertext = encrypt(value);
  await sql`
    INSERT INTO agent_secrets (organization_id, name, ciphertext, updated_at)
    VALUES (${organizationId}, ${environmentSecretName(environmentId, field)}, ${ciphertext}, now())
    ON CONFLICT (organization_id, name)
    DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
  `;
}

/**
 * Read + decrypt one credential field for a runtime environment. Returns null
 * on miss/expiry/decrypt-failure so the caller can fall back to system env.
 * Mirrors {@link readOrgSharedProviderApiKey} but keyed per-environment.
 */
export async function readEnvironmentSecret(
  environmentId: string,
  field: string,
  organizationId: string
): Promise<string | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT ciphertext
    FROM agent_secrets
    WHERE organization_id = ${organizationId}
      AND name = ${environmentSecretName(environmentId, field)}
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `) as Array<{ ciphertext: string }>;
  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch (error) {
    logger.warn(
      `Failed to decrypt environment secret ${environmentSecretName(
        environmentId,
        field
      )}: ${getErrorMessage(error)}`
    );
    return null;
  }
}

/**
 * Read + decrypt the org-shared API key for a provider (tier 2 of the
 * resolution chain above). Returns null when no row exists, the row expired,
 * or the ciphertext fails to decrypt — every miss is silent so callers keep
 * walking the chain. Shared by the worker-spawn credential path
 * (base-provider-module.ts) and the egress secret-proxy, which MUST agree on
 * this tier: run dispatch checks it via `hasCredentials`, so a proxy that
 * skips it lets an apply-provisioned org dispatch its agent only to 401 at
 * the first provider call.
 */
export async function readOrgSharedProviderApiKey(
  providerId: string,
  organizationId: string
): Promise<string | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT ciphertext
    FROM agent_secrets
    WHERE organization_id = ${organizationId}
      AND name = ${providerOrgSecretName(providerId)}
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `) as Array<{ ciphertext: string }>;
  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch (error) {
    logger.warn(
      `Failed to decrypt org-shared key for provider ${providerId}: ${getErrorMessage(error)}`
    );
    return null;
  }
}

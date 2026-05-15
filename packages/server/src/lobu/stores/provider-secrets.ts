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
export function providerOrgSecretName(providerId: string): string {
  return `provider:${providerId}:apiKey`;
}

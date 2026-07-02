import { createLogger } from "@lobu/core";
import { resolveInferenceProviderConfig } from "../../lobu/stores/provider-secrets.js";

const logger = createLogger("inference-invariant");

/**
 * The URL invariant, in one place, for both credential chains (worker-spawn
 * `base-provider-module.ts` and egress `secret-proxy.ts`).
 *
 * When an org has configured a custom upstream for a provider — i.e. its
 * `inference_providers` row carries `capabilities.text.base_url` — the request
 * is going to a tenant-defined URL. Only the credential the org admin stored
 * *alongside that URL* (the row's own `api_key_ref`) may be sent there. A
 * per-user `auth_profiles` credential or a deployment `process.env` key must
 * NEVER travel to a tenant-defined URL (credential exfiltration).
 *
 * So: custom upstream present ⇒ org-row-key-ONLY (skip profile, skip env).
 * No custom upstream ⇒ the caller walks its normal profile→org→env chain
 * against the static providers.json URL (unchanged).
 *
 * The row is read ONCE per call — base_url presence and the key come from the
 * same read — so there is no window to flip the base_url between the gate and
 * the fetch (the flip vector the plan called out).
 *
 * Text is the only modality that flows through these chains (image/stt/tts run
 * through their own dedicated services, which read their own modality block).
 * So the invariant here keys on `capabilities.text.base_url`.
 */
export type InvariantVerdict =
  /** No custom upstream for this provider/org — caller walks its normal chain. */
  | { kind: "no-custom-upstream" }
  /**
   * Custom upstream + usable org key. The caller MUST use this key and nothing
   * else, AND route to `baseUrl` (the tenant-defined URL) — never the static
   * providers.json URL. Both come from the same row read, so the URL the key is
   * consented for and the URL the request goes to cannot diverge.
   */
  | { kind: "org-only"; credential: string; baseUrl: string }
  /**
   * Custom upstream configured but the org key is missing/undecryptable. The
   * caller MUST fail closed — do NOT fall back to a profile/env key bound for a
   * tenant URL. No usable credential.
   */
  | { kind: "org-only-unavailable" };

export async function resolveUrlInvariant(
  providerSlug: string,
  organizationId: string | undefined
): Promise<InvariantVerdict> {
  if (!organizationId) return { kind: "no-custom-upstream" };

  // Text is the only modality on the credential-chain hot path (image/stt/tts
  // run through their own services). One row read gives base_url + key together.
  const config = await resolveInferenceProviderConfig(
    organizationId,
    providerSlug,
    "text"
  );
  if (!config?.custom || !config.baseUrl) {
    // No custom text upstream — the request goes to the static providers.json
    // URL, so the normal profile→org→env chain is safe.
    return { kind: "no-custom-upstream" };
  }

  if (!config.apiKey) {
    logger.warn(
      `Custom upstream configured for provider "${providerSlug}" (org ${organizationId}) but its org key is missing/undecryptable — refusing to fall back to a per-user or env credential for a tenant URL.`
    );
    return { kind: "org-only-unavailable" };
  }

  return {
    kind: "org-only",
    credential: config.apiKey,
    baseUrl: config.baseUrl,
  };
}

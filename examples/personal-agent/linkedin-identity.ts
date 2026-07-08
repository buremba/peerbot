/**
 * LinkedIn connector identity namespaces and normalization.
 *
 * Single source of truth for the LinkedIn identity vocabulary. The connector
 * (linkedin-takeout.connector.ts) imports from here, and a server that wires
 * the example package in would assemble `linkedInIdentityModule` into its
 * ingest normalizer chain — mirroring @lobu/connectors/x-identity.ts.
 *
 * `linkedin_slug` (the canonical `/in/<vanity>` slug, lowercased) is the
 * primary key for a LinkedIn person: it survives the case/protocol/`www.`/query
 * noise that full URLs carry, so the CASE-SENSITIVE `entity_identities` UNIQUE
 * index can't fork one person into duplicates. The full URL is kept only as a
 * display TRAIT, not an identity. `email` is the GENERIC cross-channel bridge
 * (namespace owned by connector-sdk, shared with Gmail/contacts), so a LinkedIn
 * person joins the same entity as their Gmail/contacts identity.
 */

import { IDENTITY } from "@lobu/connector-sdk";

/**
 * Connector-owned identity module contract. Mirrors
 * `@lobu/connectors/connector-identity-module` — redeclared here because the
 * example package depends only on `@lobu/connector-sdk`, which does not
 * re-export that type.
 */
export interface ConnectorIdentityModule {
  /** Connector/platform key. */
  key: string;
  /**
   * Namespaces this connector owns that participate in read-time event recall.
   * Each MUST have a physical `idx_events_metadata_<ns>` partial index. LinkedIn
   * owns none — `linkedin_slug` is a match/attribution key, not a recall key.
   */
  recallNamespaces: string[];
  /**
   * Normalize a value for one of this connector's namespaces. Returns
   * `undefined` when the namespace is not owned here (the caller chains to the
   * next module, then to generic SDK hygiene). `null` means the namespace IS
   * owned but the value is invalid.
   */
  normalize(namespace: string, raw: string): string | null | undefined;
}

/** Connector-owned identity namespaces (not SDK-global). */
export const LINKEDIN_IDENTITY = {
  /**
   * Canonical `/in/<vanity>` profile slug, lowercased — primary namespace for
   * attribution. Case- and URL-noise-insensitive, so the same person never
   * forks across the CASE-SENSITIVE `entity_identities` UNIQUE index.
   */
  SLUG: "linkedin_slug",
} as const;

export type LinkedInIdentityNamespace =
  (typeof LINKEDIN_IDENTITY)[keyof typeof LINKEDIN_IDENTITY];

/**
 * Extract the canonical LinkedIn vanity slug from either a full profile URL or
 * a bare slug, lowercased. `https://www.LinkedIn.com/in/Jane-Doe/?trk=x` and
 * `jane-doe` both collapse to `jane-doe`. A slug is the `/in/(<slug>)` path
 * segment; a bare input (no `/in/`) is treated as an already-extracted slug.
 * Returns `null` when no valid `[a-z0-9\-_%]` slug can be recovered.
 */
export function normalizeLinkedInSlug(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  // Full/partial URL → pull out the `/in/<slug>` segment (stops at the next
  // `/`, `?` or `#`). A bare input without `/in/` is treated as the slug.
  const match = value.match(/\/in\/([^/?#]+)/i);
  const slug = (match ? match[1] : value).toLowerCase();
  if (!/^[a-z0-9\-_%]+$/.test(slug)) return null;
  return slug;
}

/**
 * Normalize a LinkedIn identity namespace value. Returns `undefined` when the
 * namespace is not LinkedIn-owned (caller falls back to generic hygiene). The
 * generic `email` namespace is deliberately NOT handled here — connector-sdk
 * owns email normalization.
 */
export function normalizeLinkedInIdentityValue(
  namespace: string,
  raw: string
): string | null | undefined {
  switch (namespace) {
    case LINKEDIN_IDENTITY.SLUG:
      return normalizeLinkedInSlug(raw);
    default:
      return undefined;
  }
}

/** Generic email namespace, shared cross-channel bridge (owned by the SDK). */
export const LINKEDIN_EMAIL_NAMESPACE = IDENTITY.EMAIL;

/** The LinkedIn connector's contribution to the server identity wiring. */
export const linkedInIdentityModule: ConnectorIdentityModule = {
  key: "linkedin",
  // `linkedin_slug` is an attribution/match key, not recall-indexed — there is
  // no idx_events_metadata_linkedin_slug. Cross-channel email recall is handled
  // by the generic `email` namespace, not LinkedIn.
  recallNamespaces: [],
  normalize: normalizeLinkedInIdentityValue,
};

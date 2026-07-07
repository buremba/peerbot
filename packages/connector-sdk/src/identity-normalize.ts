/**
 * Canonical normalization for identity values written to entity_identities.
 *
 * Connectors call these before emitting identifiers on events. The ingestion
 * pipeline also re-runs normalization as a defensive pass, so mismatched
 * connector behavior can't poison cross-channel matching.
 *
 * Glossary — "namespace" in this file:
 *   The string `namespace` here means an *identity scope* — the type of an
 *   external identifier (`email`, `phone`, `email_domain`, etc.). Only GENERIC
 *   namespaces are normalized here; connector-specific ones (slack_user_id,
 *   github_login, …) are normalized by their own connector module.
 *   It backs the `entity_identities.namespace` column and is the unit of
 *   uniqueness for cross-connector identity matching.
 *
 *   It is NOT the memory-scope axis. Per-agent memory scoping lives on
 *   `events.metadata.agent_id` (filtered via `search_memory`'s `agent_id`
 *   arg, populated by `@lobu/openclaw-plugin` autoCapture). Identity
 *   namespaces and memory scopes are unrelated subsystems that happen to
 *   share an English word — don't conflate them when reading this file.
 */

import {
  getIdentityNamespaceDefinition,
  type IdentityNormalizerKind,
} from './identity-namespaces.js';

const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

/**
 * Return the E.164-style digit string for a phone number, or null when the
 * input doesn't look like a phone. Strips all non-digit characters (including
 * the leading `+`); does not attempt country-code inference.
 *
 * Connectors should pass in values that already represent a specific E.164
 * number. The normalizer's job is cleanup (spaces, dashes, parens, `+`),
 * not country-code guessing.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return null;
  return digits;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return null;
  if (trimmed.indexOf('@', atIndex + 1) !== -1) return null;
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  if (!local || !domain) return null;
  if (domain.indexOf('.') === -1) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Extract the canonical domain from an email address. Runs the full email
 * validator first (so a malformed address yields null, never a bogus domain),
 * then returns the lowercased part after `@`. This is what backs the derived
 * `email_domain` identity namespace: `alice@Anthropic.com` → `anthropic.com`.
 *
 * Accepts either a full email or a bare domain — passing an already-extracted
 * `anthropic.com` returns it normalized, so the engine can re-run this
 * defensively over a value that may already be a domain.
 */
export function normalizeEmailDomain(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const atIndex = trimmed.indexOf('@');
  if (atIndex === -1) {
    // Bare domain: must contain a dot and no other @-like junk.
    if (trimmed.indexOf('.') === -1) return null;
    return trimmed;
  }
  const email = normalizeEmail(trimmed);
  if (!email) return null;
  return email.slice(email.indexOf('@') + 1);
}

/**
 * Normalize `auth_user_id` (Better Auth user id). Trim + lowercase so the
 * same user id from different clients collapses consistently.
 */
export function normalizeAuthUserId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

function normalizeTrim(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * Apply a normalizer by its registry dispatch kind. The kind → function map
 * lives here; the namespace → kind map lives in the GENERIC identity namespace
 * registry (identity-namespaces.ts), so `normalizeIdentifier` has one source of
 * truth. Connector-specific namespaces are normalized by their own connector
 * module (server chains those before falling back here) and never reach this
 * switch.
 */
function applyNormalizer(
  kind: IdentityNormalizerKind,
  raw: string | null | undefined
): string | null {
  switch (kind) {
    case 'phone':
      return normalizePhone(raw);
    case 'email':
      return normalizeEmail(raw);
    case 'email_domain':
      return normalizeEmailDomain(raw);
    case 'auth_user_id':
      return normalizeAuthUserId(raw);
    case 'trim':
      return normalizeTrim(raw);
  }
}

/**
 * Normalize an identity value for a given GENERIC namespace. Dispatches through
 * the identity namespace registry's `normalizer` field. An unregistered
 * namespace falls back to trim-only so connector-owned namespaces still get
 * basic hygiene when they reach the generic fallback.
 */
export function normalizeIdentifier(
  namespace: string,
  raw: string | null | undefined
): string | null {
  const def = getIdentityNamespaceDefinition(namespace);
  if (!def) return normalizeTrim(raw);
  return applyNormalizer(def.normalizer, raw);
}

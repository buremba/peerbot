/**
 * Canonical normalization for identity values written to entity_identities.
 *
 * Connectors call these before emitting identifiers on events. The ingestion
 * pipeline also re-runs normalization as a defensive pass, so mismatched
 * connector behavior can't poison cross-channel matching.
 *
 * Glossary — "namespace" in this file:
 *   The string `namespace` here means an *identity scope* — the type of an
 *   external identifier (`email`, `phone`, `wa_jid`, `slack_user_id`, etc.).
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
 * WhatsApp JIDs carry one of these suffixes:
 *   @s.whatsapp.net   — individual, backed by an e164 phone
 *   @lid              — privacy-protected individual (no phone)
 *   @g.us             — group chat
 *   @broadcast        — broadcast list
 *   @newsletter       — channel / newsletter
 *
 * Multi-device messages arrive with a device suffix: `14155551234:5@s.whatsapp.net`.
 * We strip it so the same person on phone + linked devices collapses to one
 * identity. We lowercase, trim, and validate shape; invalid inputs return null.
 * This is a *cleanup* function, not a person-vs-non-person filter — callers
 * decide whether a normalized wa_jid is appropriate to use as a member identity.
 */
export function normalizeWaJid(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const match = trimmed.match(
    /^([a-z0-9._-]+)(?::\d+)?@(s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)$/i
  );
  if (!match) return null;
  return `${match[1]}@${match[2]}`;
}

/**
 * Slack user IDs aren't globally unique — two workspaces can both have
 * `U12345`. Prefix with the workspace (team) id so identities don't bleed
 * across orgs: `T0XYZ:U12345`.
 */
export function normalizeSlackUserId(
  teamId: string | null | undefined,
  userId: string | null | undefined
): string | null {
  if (typeof teamId !== 'string' || typeof userId !== 'string') return null;
  const t = teamId.trim();
  const u = userId.trim();
  if (!t || !u) return null;
  if (!/^[a-z0-9_-]+$/i.test(t) || !/^[a-z0-9_-]+$/i.test(u)) return null;
  return `${t}:${u}`.toUpperCase();
}

/**
 * Canonicalize an already-combined Slack identity (`T0XYZ:U12345`) for the
 * `normalizeIdentifier` dispatch. Connectors emit the team-prefixed form
 * (build it with `normalizeSlackUserId(teamId, userId)`); this is the
 * single-value cleanup pass the ingestion pipeline re-runs. Splits on the
 * first colon and re-runs the two-part validator so a malformed value (no
 * team prefix, bad chars) returns null rather than poisoning matching.
 */
export function normalizeSlackUserIdCombined(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const sep = trimmed.indexOf(':');
  if (sep <= 0 || sep === trimmed.length - 1) return null;
  return normalizeSlackUserId(trimmed.slice(0, sep), trimmed.slice(sep + 1));
}

export function normalizeNumericId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return trimmed.replace(/^0+(?=\d)/, '');
}

export function normalizeXHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!trimmed || !/^[a-z0-9_]{1,15}$/.test(trimmed)) return null;
  return trimmed;
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
 * lives here; the namespace → kind map lives in the identity namespace registry
 * (identity-namespaces.ts), so `normalizeIdentifier` has one source of truth.
 *
 * `wa_jid` / `slack_user_id` intentionally fall through to trim-only: those are
 * legacy recall namespaces whose stored rows predate stricter normalization, so
 * the registry pins them to `trim` until a backfill re-normalizes the column.
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
    case 'numeric_id':
      return normalizeNumericId(raw);
    case 'x_handle':
      return normalizeXHandle(raw);
    case 'auth_user_id':
      return normalizeAuthUserId(raw);
    case 'wa_jid':
    case 'slack_user_id':
    case 'trim':
      return normalizeTrim(raw);
  }
}

/**
 * Normalize an identity value for a given namespace. Dispatches through the
 * canonical identity namespace registry's `normalizer` field. An unregistered
 * namespace falls back to trim-only so custom connector namespaces still get
 * basic hygiene without a registry entry.
 */
export function normalizeIdentifier(
  namespace: string,
  raw: string | null | undefined
): string | null {
  const def = getIdentityNamespaceDefinition(namespace);
  if (!def) return normalizeTrim(raw);
  return applyNormalizer(def.normalizer, raw);
}

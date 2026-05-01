/**
 * Canonical normalization for identity values written to entity_identities.
 *
 * Connectors call these before emitting identifiers on events. The ingestion
 * pipeline also re-runs normalization as a defensive pass, so mismatched
 * connector behavior can't poison cross-channel matching.
 */

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

export function normalizeGithubLogin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(trimmed)) return null;
  return trimmed;
}

export function normalizeGoogleContactId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
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

/**
 * Look up the normalizer for a given namespace. Returns a noop-trimmer when
 * the namespace is unknown so custom connector namespaces still get basic
 * hygiene without special-casing.
 */
export function normalizeIdentifier(
  namespace: string,
  raw: string | null | undefined
): string | null {
  switch (namespace) {
    case 'phone':
      return normalizePhone(raw);
    case 'email':
      return normalizeEmail(raw);
    case 'wa_jid':
      return normalizeWaJid(raw);
    case 'github_login':
      return normalizeGithubLogin(raw);
    case 'google_contact_id':
      return normalizeGoogleContactId(raw);
    case 'auth_user_id':
      return normalizeAuthUserId(raw);
    default: {
      if (typeof raw !== 'string') return null;
      const trimmed = raw.trim();
      return trimmed ? trimmed : null;
    }
  }
}

/**
 * X (Twitter) connector identity namespaces and normalization.
 *
 * Single source of truth for x_user_id / x_handle rules. The connector and
 * server entity-link ingestion import from here — not from connector-sdk.
 * Connector-specific identity knowledge stays in the connector package so
 * core code never names X.
 */

import type { ConnectorIdentityModule } from './connector-identity-module.js';

/** Connector-owned identity namespaces (not SDK-global). */
export const X_IDENTITY = {
  /** Immutable X/Twitter numeric user id — primary namespace for attribution. */
  USER_ID: 'x_user_id',
  /** Mutable/reusable @handle — secondary claim, not recall-indexed. */
  HANDLE: 'x_handle',
} as const;

export type XIdentityNamespace = (typeof X_IDENTITY)[keyof typeof X_IDENTITY];

/** Immutable numeric X user id: digits only, leading zeros stripped. */
export function normalizeXUserId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return trimmed.replace(/^0+(?=\d)/, '');
}

/** Mutable @handle: strip leading @, lowercase, 1–15 [a-z0-9_]. */
export function normalizeXHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!trimmed || !/^[a-z0-9_]{1,15}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Normalize an X identity namespace value. Returns `undefined` when the
 * namespace is not X-owned (caller should fall back to generic hygiene).
 */
export function normalizeXIdentityValue(
  namespace: string,
  raw: string,
): string | null | undefined {
  switch (namespace) {
    case X_IDENTITY.USER_ID:
      return normalizeXUserId(raw);
    case X_IDENTITY.HANDLE:
      return normalizeXHandle(raw);
    default:
      return undefined;
  }
}

/** The X connector's contribution to the server identity wiring. */
export const xIdentityModule: ConnectorIdentityModule = {
  key: 'x',
  // Only the immutable user id is recall-indexed; x_handle is a mutable
  // secondary claim (see idx_events_metadata_x_user_id — no handle index).
  recallNamespaces: [X_IDENTITY.USER_ID],
  normalize: normalizeXIdentityValue,
};

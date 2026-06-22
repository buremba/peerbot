/**
 * Guard against creating an UNBOUND `app_installation` connection.
 *
 * When a connector's primary auth method is `app_installation` (e.g. github),
 * a connection bound to an install is created by the App install callback's
 * `linkGithubAppInstallation`, which stamps `config.installation_ref`. The guard
 * rejects a create/connect that would resolve to `app_installation` auth with no
 * `installation_ref` — a dead, unbound connection — and points the user at the
 * install flow.
 *
 * SELECTION-AWARE: it must NOT block a connection that resolves to a DIFFERENT
 * auth method. github also declares oauth + env_keys, so a legit create/connect
 * that supplies an auth profile slug, env/PAT creds in config, or a managedBy
 * grant uses one of those methods — the guard skips entirely. Only when no such
 * intent is present (and there is no installation_ref) does the connection fall
 * through to the app_installation primary, which is what we reject.
 *
 * Connector-agnostic: keys on the resolved auth method type (not on `github`),
 * so it covers any future app_installation connector.
 */

import { parseJsonObject } from '@lobu/core';
import {
  getEnvAuthFieldKeys,
  isPrimaryAuthMethodAppInstallation,
  normalizeConnectorAuthSchema,
} from '../../../utils/connector-auth';

function hasInstallationRef(config: Record<string, unknown>): boolean {
  const ref = config.installation_ref;
  return (
    (typeof ref === 'number' && Number.isFinite(ref)) ||
    (typeof ref === 'string' && ref.trim().length > 0)
  );
}

function hasManagedByOrg(config: Record<string, unknown>): boolean {
  const managedBy = config.managedBy;
  if (!managedBy || typeof managedBy !== 'object' || Array.isArray(managedBy)) {
    return false;
  }
  const org = (managedBy as Record<string, unknown>).org;
  return typeof org === 'string' && org.trim().length > 0;
}

/**
 * Returns an `{ error }` result to short-circuit the create/connect handler when
 * the connection would be an unbound app_installation connection, else null.
 *
 * The caller passes the auth-INTENT signals it received so the guard can tell a
 * deliberate oauth/PAT/env/managed create from a bare one that falls through to
 * app_installation.
 *
 * @param authSchema          the connector definition's `auth_schema` (raw jsonb/string)
 * @param config              the connection `config` being created
 * @param connectorKey        for the (connector-agnostic) error message
 * @param authProfileSlug     an explicitly selected auth profile (oauth/env/browser)
 * @param appAuthProfileSlug  an explicitly selected OAuth app profile
 */
export function rejectUnboundAppInstallationCreate(params: {
  authSchema: unknown;
  config: unknown;
  connectorKey: string;
  authProfileSlug?: string | null;
  appAuthProfileSlug?: string | null;
}): { error: string } | null {
  const schema = normalizeConnectorAuthSchema(params.authSchema);
  // Only connectors whose PRIMARY method is app_installation are in scope.
  if (!isPrimaryAuthMethodAppInstallation(schema)) return null;

  const config = parseJsonObject(params.config);

  // Already bound (the install-callback shape) → allow.
  if (hasInstallationRef(config)) return null;

  // A deliberate non-app_installation auth selection → the connection will use
  // THAT method, not app_installation. Skip the guard.
  if (params.authProfileSlug?.trim() || params.appAuthProfileSlug?.trim()) {
    return null;
  }
  if (hasManagedByOrg(config)) return null;
  // Env/PAT creds supplied directly in config (e.g. GITHUB_TOKEN) → env auth.
  const envKeys = getEnvAuthFieldKeys(schema);
  if (envKeys.some((key) => config[key] !== undefined && config[key] !== null)) {
    return null;
  }

  // No installation_ref and no other auth intent → this would resolve to the
  // app_installation primary with nothing to bind. Reject with install guidance.
  return {
    error:
      `Connector '${params.connectorKey}' is connected by installing its app (which links the connection automatically), not by creating a connection directly. ` +
      `Start the app install flow instead — for GitHub that's /github/app/install. ` +
      `(To use a different auth method this connector supports, pass an auth profile or credentials.)`,
  };
}

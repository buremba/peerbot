/**
 * Guard against creating an unbound `app_installation` connection.
 *
 * When a connector's PRIMARY auth method is `app_installation` (e.g. github),
 * the ONLY legitimate creator of a connection is the App install callback's
 * `linkGithubAppInstallation`, which stamps `config.installation_ref`. A user
 * creating such a connection through the normal manage_connections create/connect
 * path with no `installation_ref` would produce a dead, unbound connection
 * (resolveAppInstallationCredential falls through to a missing fallback). Reject
 * it up front and point the user at the install flow.
 *
 * Connector-agnostic: keys on the auth method type, so it covers any future
 * app_installation connector — not just github.
 */

import { parseJsonObject } from '@lobu/core';
import {
  isPrimaryAuthMethodAppInstallation,
  normalizeConnectorAuthSchema,
} from '../../../utils/connector-auth';

/**
 * Returns an `{ error }` result to short-circuit the create/connect handler when
 * the connection would be an unbound app_installation connection, else null.
 *
 * @param authSchema  the connector definition's `auth_schema` (raw jsonb/string)
 * @param config      the connection `config` being created (may carry installation_ref)
 */
export function rejectUnboundAppInstallationCreate(params: {
  authSchema: unknown;
  config: unknown;
}): { error: string } | null {
  const schema = normalizeConnectorAuthSchema(params.authSchema);
  if (!isPrimaryAuthMethodAppInstallation(schema)) return null;

  const config = parseJsonObject(params.config);
  const ref = config.installation_ref;
  const hasRef =
    (typeof ref === 'number' && Number.isFinite(ref)) ||
    (typeof ref === 'string' && ref.trim().length > 0);
  if (hasRef) return null;

  return {
    error:
      'This connector is connected by installing the GitHub App, not by creating a connection directly. Start the install from the GitHub App install flow (/github/app/install) — the install callback links the connection automatically.',
  };
}

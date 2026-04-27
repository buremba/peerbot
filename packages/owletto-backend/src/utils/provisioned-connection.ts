/**
 * Service function for creating connections during automated provisioning flows
 * (e.g., social login auto-provisioning). Wraps manage_connections tool handler
 * with proper typing and a simplified return interface.
 */

import type { Env } from '../index';
import { manageConnections } from '../tools/admin/manage_connections';
import logger from './logger';
import { getConfiguredPublicOrigin } from './public-origin';

interface CreateProvisionedConnectionParams {
  organizationId: string;
  connectorKey: string;
  displayName: string;
  authProfileSlug: string;
  appAuthProfileSlug: string;
  config: Record<string, unknown>;
  userId: string;
  env: Env;
  requestUrl?: string;
}

interface CreateProvisionedConnectionResult {
  connectionId: number | null;
  error: string | null;
}

export async function createProvisionedConnection(
  params: CreateProvisionedConnectionParams
): Promise<CreateProvisionedConnectionResult> {
  try {
    const result = await manageConnections(
      {
        action: 'create',
        connector_key: params.connectorKey,
        display_name: params.displayName,
        auth_profile_slug: params.authProfileSlug,
        app_auth_profile_slug: params.appAuthProfileSlug,
        config: params.config,
      } as Parameters<typeof manageConnections>[0],
      params.env,
      {
        organizationId: params.organizationId,
        userId: params.userId,
        memberRole: null,
        isAuthenticated: true,
        tokenType: 'session',
        scopedToOrg: true,
        allowCrossOrg: false,
        requestUrl: params.requestUrl,
        baseUrl: getConfiguredPublicOrigin() ?? undefined,
      }
    );

    if ('error' in result && result.error) {
      return { connectionId: null, error: String(result.error) };
    }

    const connectionId =
      'connection' in result
        ? Number((result.connection as { id?: number } | undefined)?.id) || null
        : null;

    return { connectionId, error: null };
  } catch (err) {
    logger.error({ err, connectorKey: params.connectorKey }, 'createProvisionedConnection failed');
    return { connectionId: null, error: err instanceof Error ? err.message : String(err) };
  }
}

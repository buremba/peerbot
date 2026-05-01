import type { EntityLinkOverrides } from '@lobu/connector-sdk';
import { getDb } from '../db/client';
import { clearEntityLinkRulesCache } from './entity-link-upsert';
import {
  validateEntityLinkOverrides,
  verifyEntityLinkOverrideTargets,
} from './entity-link-validation';

/**
 * Validate + verify + persist connector entity-link overrides for an org.
 * Returns an error message on failure, null on success. Callers should short-
 * circuit and return `{ error }` when this returns a string.
 *
 * The caller is responsible for ensuring the connector definition row exists
 * before invoking this — used by install/create/connect (after install or
 * ensure-install), by the standalone set_connector_entity_link_overrides
 * admin action, and by the CLI install script.
 */
export async function applyEntityLinkOverrides(
  organizationId: string,
  connectorKey: string,
  overrides: unknown
): Promise<string | null> {
  const structural = validateEntityLinkOverrides(overrides);
  if (structural.length > 0) {
    return `Invalid overrides:\n  - ${structural.join('\n  - ')}`;
  }
  const typed = (overrides ?? null) as EntityLinkOverrides | null;
  const missing = await verifyEntityLinkOverrideTargets(typed, organizationId);
  if (missing.length > 0) {
    return missing.join('\n');
  }

  const sql = getDb();
  const updated = await sql`
    UPDATE connector_definitions
    SET entity_link_overrides = ${typed ? sql.json(typed) : null},
        updated_at = NOW()
    WHERE key = ${connectorKey}
      AND organization_id = ${organizationId}
      AND status = 'active'
    RETURNING key
  `;
  if (updated.length === 0) {
    return `Connector '${connectorKey}' not found`;
  }

  clearEntityLinkRulesCache();
  return null;
}

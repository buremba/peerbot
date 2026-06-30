/**
 * Validation + override resolution for the declarative entityLinks rules.
 * The connector-declared rule shape is enforced at connector-author time by
 * the TS types, so runtime validation is only applied to user-supplied
 * overrides (which arrive via MCP as untrusted JSON).
 */
import type { EntityLinkOverrides, EntityLinkRule } from '@lobu/connector-sdk';
import { getDb, pgTextArray } from '../db/client';
import { clearEntityLinkRulesCache } from './entity-link-upsert';

export function validateEntityLinkOverrides(overrides: unknown): string[] {
  if (overrides === null || overrides === undefined) return [];
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return ['entity_link_overrides must be an object keyed by entityType'];
  }
  const errors: string[] = [];
  for (const [entityType, override] of Object.entries(overrides as Record<string, unknown>)) {
    const ctx = `entity_link_overrides.${entityType}`;
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      errors.push(`${ctx}: must be an object`);
      continue;
    }
    const o = override as Record<string, unknown>;
    if (o.disable !== undefined && typeof o.disable !== 'boolean') {
      errors.push(`${ctx}.disable: must be a boolean`);
    }
    if (o.retargetEntityType !== undefined && typeof o.retargetEntityType !== 'string') {
      errors.push(`${ctx}.retargetEntityType: must be a string`);
    }
    if (o.autoCreate !== undefined && typeof o.autoCreate !== 'boolean') {
      errors.push(`${ctx}.autoCreate: must be a boolean`);
    }
    if (o.createWhen !== undefined && o.createWhen !== null) {
      const p = o.createWhen;
      if (typeof p !== 'object' || Array.isArray(p) || typeof (p as { path?: unknown }).path !== 'string') {
        errors.push(`${ctx}.createWhen: must be null or an object with a string 'path'`);
      }
    }
    if (
      o.maskIdentities !== undefined &&
      (!Array.isArray(o.maskIdentities) || !o.maskIdentities.every((s) => typeof s === 'string'))
    ) {
      errors.push(`${ctx}.maskIdentities: must be an array of strings`);
    }
  }
  return errors;
}

/**
 * Verify that every `retargetEntityType` in the overrides points to an
 * existing entity type in the given org. Returns an array of error messages
 * (empty if all targets resolve). The caller is expected to have already
 * passed the overrides through `validateEntityLinkOverrides` for structural
 * checks.
 */
export async function verifyEntityLinkOverrideTargets(
  overrides: EntityLinkOverrides | null | undefined,
  organizationId: string
): Promise<string[]> {
  if (!overrides) return [];
  const targets = new Set<string>();
  for (const override of Object.values(overrides)) {
    if (override?.retargetEntityType) targets.add(override.retargetEntityType);
  }
  if (targets.size === 0) return [];

  const sql = getDb();
  const rows = await sql`
    SELECT slug FROM entity_types
    WHERE organization_id = ${organizationId}
      AND deleted_at IS NULL
      AND slug = ANY(${pgTextArray(Array.from(targets))}::text[])
  `;
  const found = new Set(rows.map((r) => r.slug as string));
  const missing = Array.from(targets).filter((slug) => !found.has(slug));
  return missing.map(
    (slug) =>
      `entity_link_overrides retargetEntityType '${slug}' does not exist in this organization. Create the entity type first.`
  );
}

/**
 * Apply per-install overrides on top of connector-declared rules. Shallow
 * merge keyed by rule.entityType. Returns a new array; does not mutate input.
 */
export function resolveEntityLinkRules(
  declaredRules: EntityLinkRule[],
  overrides: EntityLinkOverrides | null | undefined
): EntityLinkRule[] {
  if (!overrides) return declaredRules;
  const out: EntityLinkRule[] = [];
  for (const rule of declaredRules) {
    const ov = overrides[rule.entityType];
    if (!ov) {
      out.push(rule);
      continue;
    }
    if (ov.disable) continue;

    const maskSet = new Set(ov.maskIdentities ?? []);
    const nextIdentities =
      maskSet.size > 0
        ? rule.identities.filter((spec) => !maskSet.has(spec.namespace))
        : rule.identities;
    if (nextIdentities.length === 0) continue;

    out.push({
      ...rule,
      entityType: ov.retargetEntityType || rule.entityType,
      autoCreate: typeof ov.autoCreate === 'boolean' ? ov.autoCreate : rule.autoCreate,
      // `null` clears the gate (mint on every miss); an object replaces it;
      // omitted keeps the connector's declared gate (preserved by `...rule`).
      createWhen: ov.createWhen === null ? undefined : (ov.createWhen ?? rule.createWhen),
      identities: nextIdentities,
    });
  }
  return out;
}

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

/**
 * Validation + override resolution for the declarative entityLinks rules.
 * The connector-declared rule shape is enforced at connector-author time by
 * the TS types, so runtime validation is only applied to user-supplied
 * overrides (which arrive via MCP as untrusted JSON).
 */
import type { EntityLinkOverrides, EntityLinkRule } from '@lobu/connector-sdk';
import { getDb } from '../db/client';

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
      AND slug = ANY(${Array.from(targets)})
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
      identities: nextIdentities,
    });
  }
  return out;
}

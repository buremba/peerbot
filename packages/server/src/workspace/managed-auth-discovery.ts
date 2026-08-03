import { getDb, pgTextArray } from '../db/client';

export interface ManagedAuthConnectorOffer {
  connector_key: string;
  provider: string;
}

/**
 * List OAuth connectors backed by an active managed app in public orgs.
 *
 * This deliberately mirrors getPrimaryAuthProfileForKind's provider fallback:
 * an active provider-wide Google app can serve both Gmail and Calendar even
 * when the profile's connector_key names only one of them. Only identifiers
 * are returned; app credentials and profile metadata never leave the server.
 */
export async function listManagedAuthConnectorOffers(
  organizationIds: string[],
): Promise<Map<string, ManagedAuthConnectorOffer[]>> {
  if (organizationIds.length === 0) return new Map();

  const sql = getDb();
  const rows = (await sql`
    SELECT DISTINCT
      d.organization_id,
      d.key AS connector_key,
      lower(method->>'provider') AS provider
    FROM connector_definitions d
    JOIN "organization" o ON o.id = d.organization_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(d.auth_schema->'methods') = 'array'
          THEN d.auth_schema->'methods'
        ELSE '[]'::jsonb
      END
    ) method
    WHERE d.organization_id = ANY(${pgTextArray(organizationIds)}::text[])
      AND d.status = 'active'
      AND o.visibility = 'public'
      AND method->>'type' = 'oauth'
      AND NULLIF(method->>'provider', '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM auth_profiles ap
        WHERE ap.organization_id = d.organization_id
          AND ap.profile_kind = 'oauth_app'
          AND ap.status = 'active'
          AND (
            ap.connector_key = d.key
            OR lower(ap.provider) = lower(method->>'provider')
          )
      )
    ORDER BY d.organization_id, d.key
  `) as unknown as Array<{
    organization_id: string;
    connector_key: string;
    provider: string;
  }>;

  const byOrganization = new Map<string, ManagedAuthConnectorOffer[]>();
  for (const row of rows) {
    const offers = byOrganization.get(row.organization_id) ?? [];
    offers.push({ connector_key: row.connector_key, provider: row.provider });
    byOrganization.set(row.organization_id, offers);
  }
  return byOrganization;
}

export async function resolveManagedAuthConnectorOffer(params: {
  organizationSlug: string;
  connectorKey: string;
}): Promise<{
  organizationId: string;
  organizationSlug: string;
  provider: string;
} | null> {
  const sql = getDb();
  const organizations = (await sql`
    SELECT id, slug
    FROM "organization"
    WHERE slug = ${params.organizationSlug}
      AND visibility = 'public'
    LIMIT 1
  `) as unknown as Array<{ id: string; slug: string }>;
  const organization = organizations[0];
  if (!organization) return null;

  const offers = await listManagedAuthConnectorOffers([organization.id]);
  const offer = offers
    .get(organization.id)
    ?.find((candidate) => candidate.connector_key === params.connectorKey);
  return offer
    ? {
        organizationId: organization.id,
        organizationSlug: organization.slug,
        provider: offer.provider,
      }
    : null;
}

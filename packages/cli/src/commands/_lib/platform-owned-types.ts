/**
 * Relationship slugs the platform owns outright.
 *
 * The ACL syncs create and maintain these types themselves, and once the server
 * classifies one as authorization-bearing the schema surfaces refuse client
 * writes to it. Any CLI command that would create or update a relationship type
 * has to skip these, or it fails for every config that declares one.
 *
 * Keyed on the slug rather than the server's `purpose`, which no CLI command
 * fetches. That is deliberate: the slug is reserved, so keying on it covers the
 * window BEFORE classification as well as after.
 */
const PLATFORM_OWNED_RELATIONSHIP_SLUGS = new Set(["member_of"]);

export function isPlatformOwnedRelationshipSlug(slug: string): boolean {
  return PLATFORM_OWNED_RELATIONSHIP_SLUGS.has(slug);
}

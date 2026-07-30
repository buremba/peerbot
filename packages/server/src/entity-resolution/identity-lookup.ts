/**
 * The identifier→owner direction of `entity_identities`, plus the writer that
 * attaches claims without stealing or silently dropping them.
 *
 * `identities.ts` next door loads entity→claims, which is what the resolution
 * policy needs once it already has candidate entities. This module answers the
 * question a *writer* has to ask first: "does anything already claim this
 * phone?" Without it a create path inserts blindly and mints the duplicate that
 * a human then has to review away.
 */

import { normalizeIdentifier } from "@lobu/connector-sdk/identity-normalize";
import {
	getIdentityNamespaceDefinition,
	IDENTITY,
} from "@lobu/connector-sdk/identity-namespaces";
import { type DbClient, pgTextArray } from "../db/client";
import type { ResolutionIdentity } from "./policy";

/**
 * Map key for one claim. Structural rather than delimiter-joined: `namespace`
 * and `identifier` are both free-form, so any single separator lets
 * `{ns:"a:b", id:"c"}` collide with `{ns:"a", id:"b:c"}` and one entity's claim
 * be read as another's.
 */
export function identityKey(identity: ResolutionIdentity): string {
	return JSON.stringify([identity.namespace, identity.identifier]);
}

/**
 * Canonicalize generic namespaces and their values. Connector-owned/custom
 * namespaces keep their spelling and use the SDK's trim-only fallback.
 */
/**
 * The only namespaces a caller may author through the tool surface.
 *
 * An ALLOW-list, deliberately. A deny-list cannot be made complete: there is no
 * single enumeration of server-written namespaces — `CONNECTOR_IDENTITY_MODULES`
 * registers only github/slack/x, while WhatsApp, Instagram and LinkedIn write
 * `wa_jid`, `ig_username` and `linkedin_slug` without appearing there. Anything
 * missed becomes squattable.
 *
 * Squatting matters because these claims are unique per org. `auth_user_id` is
 * the sharpest case: `authz/member-claim-predicate` resolves a signed-in user to
 * their `$member` through exactly that claim, so a claim reserved first would
 * make the real provisioning write lose its ON CONFLICT and silently break
 * member and ACL resolution.
 *
 * Widen only deliberately, and only to namespaces the server never writes.
 */
const CALLER_AUTHORED_NAMESPACES: ReadonlySet<string> = new Set<string>([
	IDENTITY.EMAIL,
	IDENTITY.PHONE,
]);

export function normalizeRequestedIdentities(
	requested: Array<{ namespace: string; identifier: string }> | undefined,
): ResolutionIdentity[] {
	if (!requested || requested.length === 0) return [];
	const out = new Map<string, ResolutionIdentity>();
	for (const item of requested) {
		const suppliedNamespace = item.namespace.trim();
		if (!suppliedNamespace) continue;
		const genericNamespace = suppliedNamespace.toLowerCase();
		if (!CALLER_AUTHORED_NAMESPACES.has(genericNamespace)) continue;
		const genericDefinition =
			getIdentityNamespaceDefinition(genericNamespace);
		if (genericDefinition && !genericDefinition.uniquePerOrg) continue;
		const namespace = genericDefinition ? genericNamespace : suppliedNamespace;
		const identifier = normalizeIdentifier(namespace, item.identifier);
		if (!identifier) continue;
		const identity = { namespace, identifier };
		out.set(identityKey(identity), identity);
	}
	return [...out.values()];
}

/**
 * The live entity owning each claim, keyed by {@link identityKey}. A missing
 * key means nothing claims it yet.
 */
export async function findEntitiesByIdentity(
	db: DbClient,
	input: { organizationId: string; identities: ResolutionIdentity[] },
): Promise<Map<string, number>> {
	const owners = new Map<string, number>();
	if (input.identities.length === 0) return owners;

	// De-dupe before querying: a batch routinely repeats the same identifier.
	const wanted = new Map<string, ResolutionIdentity>();
	for (const identity of input.identities) {
		wanted.set(identityKey(identity), identity);
	}
	const namespaces = [...wanted.values()].map((i) => i.namespace);
	const identifiers = [...wanted.values()].map((i) => i.identifier);

	const rows = await db<{
		entity_id: number;
		namespace: string;
		identifier: string;
	}>`
		SELECT ei.entity_id, ei.namespace, ei.identifier
		FROM entity_identities ei
		JOIN entities e ON e.id = ei.entity_id
		WHERE ei.organization_id = ${input.organizationId}
		  AND ei.deleted_at IS NULL
		  AND e.deleted_at IS NULL
		  AND (ei.namespace, ei.identifier) IN (
		    SELECT ns, ident
		    FROM unnest(
		      ${pgTextArray(namespaces)}::text[],
		      ${pgTextArray(identifiers)}::text[]
		    ) AS u(ns, ident)
		  )
	`;
	for (const row of rows) {
		owners.set(
			identityKey({ namespace: row.namespace, identifier: row.identifier }),
			Number(row.entity_id),
		);
	}
	return owners;
}

/**
 * Attach claims to `entityId`, returning the pairs this INSERT made (or
 * completed) for it.
 *
 * Deliberately one statement and no follow-up read. A claim already held by
 * this same entity with its provenance already filled does not match the
 * DO UPDATE predicate and so does not come back — that is the steady state for
 * a repeat message from a known sender, and it must not cost a second query.
 * Widening the predicate to force those rows to return would write a new row
 * version per message, adding WAL and bloat to the hottest ingestion path.
 *
 * Callers that need to know about CONTESTED claims (held by a different entity)
 * derive that from the ownership map they already fetched to resolve the entity
 * in the first place — see `contestedAgainst`. Nothing here needs to re-read it.
 *
 * Errors propagate: a failed identity write must not read as "this entity has
 * no identities", which is what lets the next writer mint a duplicate.
 */
export async function attachEntityIdentities(
	db: DbClient,
	input: {
		organizationId: string;
		entityId: number;
		identities: ResolutionIdentity[];
		sourceConnector: string;
		connectionId?: number | null;
	},
): Promise<ResolutionIdentity[]> {
	if (input.identities.length === 0) return [];
	const identities = [
		...new Map(
			input.identities.map((identity) => [identityKey(identity), identity]),
		).values(),
	].sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
	const namespaces = identities.map((i) => i.namespace);
	const identifiers = identities.map((i) => i.identifier);

	const rows = await db<{ namespace: string; identifier: string }>`
		INSERT INTO entity_identities (
			organization_id, entity_id, namespace, identifier,
			source_connector, connection_id
		)
		SELECT ${input.organizationId}, ${input.entityId}, v.ns, v.ident,
		       ${input.sourceConnector}, ${input.connectionId ?? null}
		FROM unnest(
			${pgTextArray(namespaces)}::text[],
			${pgTextArray(identifiers)}::text[]
		) AS v(ns, ident)
		ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
		DO UPDATE SET connection_id = EXCLUDED.connection_id
		WHERE entity_identities.entity_id = EXCLUDED.entity_id
		  AND entity_identities.connection_id IS NULL
		  AND EXCLUDED.connection_id IS NOT NULL
		RETURNING namespace, identifier
	`;
	return rows.map((r) => ({
		namespace: r.namespace,
		identifier: r.identifier,
	}));
}

/**
 * The requested claims that a DIFFERENT live entity already owns, according to
 * an ownership map the caller already has. Pure — no query.
 *
 * These are left with their owner rather than stolen, but they are a real
 * "these two may be the same thing" signal, so callers surface them instead of
 * dropping them.
 */
export function contestedAgainst(
	owners: Map<string, number>,
	entityId: number,
	identities: ResolutionIdentity[],
): ResolutionIdentity[] {
	return identities.filter((identity) => {
		const owner = owners.get(identityKey(identity));
		return owner !== undefined && owner !== entityId;
	});
}

/**
 * Normalize requested claims and resolve them to a single existing owner.
 *
 * `decision` is what a create path should do:
 *  - `create` — nothing claims these; insert a new entity and attach them.
 *  - `attach` — exactly one live entity owns one or more; use it instead of
 *    minting a duplicate.
 *  - `ambiguous` — two or more different entities own different claims in the
 *    same request. Fusing them is a merge decision with real people on both
 *    sides, so this path must not guess: surface the candidates instead.
 */
export function resolveIdentityOwner(
	owners: Map<string, number>,
	identities: ResolutionIdentity[],
): {
	decision: "create" | "attach" | "ambiguous";
	entityId?: number;
	candidateEntityIds: number[];
} {
	const found = new Set<number>();
	for (const identity of identities) {
		const owner = owners.get(identityKey(identity));
		if (owner !== undefined) found.add(owner);
	}
	const candidateEntityIds = [...found].sort((l, r) => l - r);
	if (candidateEntityIds.length === 0) {
		return { decision: "create", candidateEntityIds };
	}
	if (candidateEntityIds.length === 1) {
		return {
			decision: "attach",
			entityId: candidateEntityIds[0],
			candidateEntityIds,
		};
	}
	return { decision: "ambiguous", candidateEntityIds };
}

import { type DbClient, pgBigintArray } from "../db/client";
import {
	normalizedResolutionRuleKeys,
	readEntityResolutionRules,
} from "./policy";

interface ResolutionCandidate {
	id: number;
	metadata: Record<string, unknown>;
}

interface ResolutionGroup {
	winnerId: number;
	loserIds: number[];
}

function populatedFieldCount(candidate: ResolutionCandidate): number {
	return Object.values(candidate.metadata).filter((value) => {
		if (value === null || value === undefined || value === "") return false;
		return !Array.isArray(value) || value.length > 0;
	}).length;
}

/**
 * Build connected duplicate components from schema-declared identity rules.
 * This is intentionally server-side: reaction scripts submit IDs only and can
 * neither forge normalized evidence nor carry a second policy implementation.
 */
export function discoverEntityResolutionGroups(input: {
	metadataSchema: unknown;
	entityTypeSlug?: string | null;
	candidates: ResolutionCandidate[];
	maxGroupSize?: number;
	maxGroups?: number;
	maxOperations?: number;
}): {
	groups: ResolutionGroup[];
	oversizedGroupCount: number;
	deferredCandidateCount: number;
} {
	const maxGroupSize = input.maxGroupSize ?? 26;
	const maxGroups = input.maxGroups ?? 199;
	const maxOperations = input.maxOperations ?? 199;
	const candidates = new Map(
		input.candidates.map((candidate) => [candidate.id, candidate]),
	);
	const parent = new Map([...candidates.keys()].map((id) => [id, id]));
	const find = (id: number): number => {
		const next = parent.get(id);
		if (next === undefined)
			throw new Error(`Unknown resolution candidate ${id}`);
		if (next === id) return id;
		const root = find(next);
		parent.set(id, root);
		return root;
	};
	const union = (left: number, right: number) => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot === rightRoot) return;
		parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
	};

	const ownersByIdentity = new Map<string, number[]>();
	const identitiesByCandidate = new Map<number, Set<string>>(
		[...candidates.keys()].map((id) => [id, new Set()]),
	);
	for (const rule of readEntityResolutionRules(input.metadataSchema, {
		entityTypeSlug: input.entityTypeSlug,
	})) {
		for (const candidate of candidates.values()) {
			for (const value of normalizedResolutionRuleKeys(candidate, rule)) {
				const key = `${rule.normalizer}:${rule.fields.join("\u001f")}:${value}`;
				identitiesByCandidate.get(candidate.id)?.add(key);
				const owners = ownersByIdentity.get(key) ?? [];
				owners.push(candidate.id);
				ownersByIdentity.set(key, owners);
			}
		}
	}
	for (const owners of ownersByIdentity.values()) {
		const [first, ...rest] = [...new Set(owners)].sort((a, b) => a - b);
		if (first === undefined || rest.length === 0) continue;
		for (const owner of rest) union(first, owner);
	}

	const components = new Map<number, ResolutionCandidate[]>();
	for (const candidate of candidates.values()) {
		const root = find(candidate.id);
		const component = components.get(root) ?? [];
		component.push(candidate);
		components.set(root, component);
	}

	let oversizedGroupCount = 0;
	let deferredCandidateCount = 0;
	const groups = [...components.values()]
		.filter((component) => component.length > 1)
		.flatMap((component) => {
			if (component.length > maxGroupSize) {
				oversizedGroupCount += 1;
				return [];
			}
			const sharesIdentity = (leftId: number, rightId: number): boolean => {
				const left = identitiesByCandidate.get(leftId);
				const right = identitiesByCandidate.get(rightId);
				if (!left || !right) return false;
				const [smaller, larger] =
					left.size <= right.size ? [left, right] : [right, left];
				return [...smaller].some((identity) => larger.has(identity));
			};
			const directNeighborCount = (candidateId: number): number =>
				component.reduce(
					(total, other) =>
						total +
						(other.id !== candidateId && sharesIdentity(candidateId, other.id)
							? 1
							: 0),
					0,
				);
			const ranked = component.sort((left, right) => {
				const completeness =
					populatedFieldCount(right) - populatedFieldCount(left);
				if (completeness !== 0) return completeness;
				const connectivity =
					directNeighborCount(right.id) - directNeighborCount(left.id);
				if (connectivity !== 0) return connectivity;
				return left.id - right.id;
			});
			const winner = ranked[0];
			if (!winner) return [];
			const directLoserIds = ranked
				.slice(1)
				.filter((candidate) => sharesIdentity(winner.id, candidate.id))
				.map((candidate) => candidate.id)
				.sort((left, right) => left - right);
			deferredCandidateCount += component.length - directLoserIds.length - 1;
			return [
				{
					winnerId: winner.id,
					loserIds: directLoserIds,
				},
			];
		})
		.sort((left, right) => left.winnerId - right.winnerId);
	if (groups.length > maxGroups) {
		throw new Error(
			`More than ${maxGroups} identity components need resolution; no changes were queued`,
		);
	}
	const operationCount = groups.reduce(
		(total, group) => total + group.loserIds.length,
		0,
	);
	if (operationCount > maxOperations) {
		throw new Error(
			`More than ${maxOperations} duplicate decisions need resolution; no changes were queued`,
		);
	}
	return { groups, oversizedGroupCount, deferredCandidateCount };
}

export async function discoverWorkspaceResolutionGroups(
	db: DbClient,
	input: {
		organizationId: string;
		candidateIds: number[];
		maxGroups?: number;
		maxOperations?: number;
	},
): Promise<{
	candidatesScanned: number;
	groups: ResolutionGroup[];
	oversizedGroupCount: number;
	deferredCandidateCount: number;
}> {
	const rows = await db<{
		id: number;
		entity_type_id: number;
		metadata: Record<string, unknown>;
		metadata_schema: Record<string, unknown> | null;
		entity_type_slug: string;
	}>`
		SELECT entity.id, entity.entity_type_id, entity.metadata,
		       type.metadata_schema, type.slug AS entity_type_slug
		FROM entities entity
		JOIN entity_types type ON type.id = entity.entity_type_id
		WHERE entity.organization_id = ${input.organizationId}
		  AND entity.id = ANY(${pgBigintArray(input.candidateIds)}::bigint[])
		  AND entity.deleted_at IS NULL
	`;
	type ResolutionRow = (typeof rows)[number];
	const byType = new Map<number, ResolutionRow[]>();
	for (const row of rows) {
		const typeId = Number(row.entity_type_id);
		const bucket = byType.get(typeId) ?? [];
		bucket.push(row);
		byType.set(typeId, bucket);
	}

	let oversizedGroupCount = 0;
	let deferredCandidateCount = 0;
	const groups: ResolutionGroup[] = [];
	for (const typeRows of byType.values()) {
		const discovered = discoverEntityResolutionGroups({
			metadataSchema: typeRows[0]?.metadata_schema,
			entityTypeSlug: typeRows[0]?.entity_type_slug,
			candidates: typeRows.map((row) => ({
				id: Number(row.id),
				metadata: row.metadata ?? {},
			})),
			maxGroups: input.maxGroups ?? 199,
			maxOperations: input.maxOperations ?? 199,
		});
		groups.push(...discovered.groups);
		oversizedGroupCount += discovered.oversizedGroupCount;
		deferredCandidateCount += discovered.deferredCandidateCount;
	}
	const maxGroups = input.maxGroups ?? 199;
	if (groups.length > maxGroups) {
		throw new Error(
			`More than ${maxGroups} identity components need resolution; no changes were queued`,
		);
	}
	const maxOperations = input.maxOperations ?? 199;
	if (
		groups.reduce((total, group) => total + group.loserIds.length, 0) >
		maxOperations
	) {
		throw new Error(
			`More than ${maxOperations} duplicate decisions need resolution; no changes were queued`,
		);
	}
	return {
		candidatesScanned: rows.length,
		groups,
		oversizedGroupCount,
		deferredCandidateCount,
	};
}

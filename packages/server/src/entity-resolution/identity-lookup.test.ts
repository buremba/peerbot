/**
 * The pure half of identity-lookup: how a create path decides between
 * attaching to what exists, minting a new entity, and refusing to guess.
 */

import { describe, expect, it } from "vitest";
import {
	contestedAgainst,
	identityKey,
	normalizeRequestedIdentities,
	resolveIdentityOwner,
} from "./identity-lookup";

const phone = (identifier: string) => ({ namespace: "phone", identifier });

describe("normalizeRequestedIdentities", () => {
	it("canonicalizes generic namespace spelling and value", () => {
		expect(
			normalizeRequestedIdentities([
				{ namespace: " Email ", identifier: " Alice@Example.COM " },
			]),
		).toEqual([{ namespace: "email", identifier: "alice@example.com" }]);
	});

	it("de-duplicates repeated claims", () => {
		expect(
			normalizeRequestedIdentities([
				{ namespace: "phone", identifier: "+90 532 235 65 86" },
				{ namespace: "phone", identifier: "905322356586" },
			]),
		).toEqual([{ namespace: "phone", identifier: "905322356586" }]);
	});

	it("refuses a custom namespace — the server may own it", () => {
		expect(
			normalizeRequestedIdentities([
				{ namespace: "crm_contact_id", identifier: "42" },
			]),
		).toEqual([]);
	});

	it("drops generic namespaces that are not unique per organization", () => {
		expect(
			normalizeRequestedIdentities([
				{ namespace: "email_domain", identifier: "example.com" },
			]),
		).toEqual([]);
	});

	it("refuses server-owned namespaces so a caller cannot squat them", () => {
		// auth_user_id is how authz/member-claim-predicate resolves a signed-in
		// user to their $member, and it is unique per org — reserving one would
		// make the real provisioning write lose and break member/ACL resolution.
		expect(
			normalizeRequestedIdentities([
				{ namespace: "auth_user_id", identifier: "user_abc" },
				{ namespace: "AUTH_USER_ID", identifier: "user_abc" },
				{ namespace: "slack_user_id", identifier: "U123" },
				{ namespace: "github_login", identifier: "octocat" },
				{ namespace: "wa_jid", identifier: "905322356586@s.whatsapp.net" },
				{ namespace: "watcher_key", identifier: "k1" },
			]),
		).toEqual([]);
	});

	it("still accepts the user-authored namespaces", () => {
		expect(
			normalizeRequestedIdentities([
				{ namespace: "phone", identifier: "+90 532 235 65 86" },
				{ namespace: "email", identifier: "A@B.com" },
			]),
		).toEqual([
			{ namespace: "phone", identifier: "905322356586" },
			{ namespace: "email", identifier: "a@b.com" },
		]);
	});
});

describe("identityKey", () => {
	it("does not let a separator in one part impersonate another claim", () => {
		// A delimiter-joined key would make these two collide, and one entity's
		// claim would be read as another's.
		expect(identityKey({ namespace: "a:b", identifier: "c" })).not.toBe(
			identityKey({ namespace: "a", identifier: "b:c" }),
		);
		expect(identityKey({ namespace: "a b", identifier: "c" })).not.toBe(
			identityKey({ namespace: "a", identifier: "b c" }),
		);
	});

	it("is stable for the same claim", () => {
		expect(identityKey(phone("905322356586"))).toBe(
			identityKey(phone("905322356586")),
		);
	});
});

describe("resolveIdentityOwner", () => {
	it("creates when nothing claims the identifiers", () => {
		expect(resolveIdentityOwner(new Map(), [phone("905322356586")])).toEqual({
			decision: "create",
			candidateEntityIds: [],
		});
	});

	it("attaches to the single existing owner", () => {
		const owners = new Map([[identityKey(phone("905322356586")), 42]]);
		expect(resolveIdentityOwner(owners, [phone("905322356586")])).toEqual({
			decision: "attach",
			entityId: 42,
			candidateEntityIds: [42],
		});
	});

	it("attaches when several identifiers all point at the same entity", () => {
		const owners = new Map([
			[identityKey(phone("905322356586")), 42],
			[identityKey({ namespace: "email", identifier: "a@b.com" }), 42],
		]);
		const resolved = resolveIdentityOwner(owners, [
			phone("905322356586"),
			{ namespace: "email", identifier: "a@b.com" },
		]);
		expect(resolved.decision).toBe("attach");
		expect(resolved.entityId).toBe(42);
	});

	it("refuses to guess when identifiers point at DIFFERENT entities", () => {
		// Picking either one would silently fuse two real people; picking neither
		// and creating a third would be worse. The caller has to decide.
		const owners = new Map([
			[identityKey(phone("905322356586")), 42],
			[identityKey({ namespace: "email", identifier: "a@b.com" }), 7],
		]);
		expect(
			resolveIdentityOwner(owners, [
				phone("905322356586"),
				{ namespace: "email", identifier: "a@b.com" },
			]),
		).toEqual({ decision: "ambiguous", candidateEntityIds: [7, 42] });
	});

	it("ignores owners for identifiers that were not requested", () => {
		const owners = new Map([[identityKey(phone("999")), 42]]);
		expect(resolveIdentityOwner(owners, [phone("905322356586")]).decision).toBe(
			"create",
		);
	});
});

describe("contestedAgainst", () => {
	it("reports a claim held by a different entity", () => {
		const owners = new Map([[identityKey(phone("905322356586")), 7]]);
		expect(contestedAgainst(owners, 42, [phone("905322356586")])).toEqual([
			phone("905322356586"),
		]);
	});

	it("does not report a claim this entity already holds", () => {
		const owners = new Map([[identityKey(phone("905322356586")), 42]]);
		expect(contestedAgainst(owners, 42, [phone("905322356586")])).toEqual([]);
	});

	it("does not report an unclaimed identifier", () => {
		expect(contestedAgainst(new Map(), 42, [phone("905322356586")])).toEqual([]);
	});
});

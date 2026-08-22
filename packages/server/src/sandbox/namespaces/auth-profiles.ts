/**
 * ClientSDK `authProfiles` namespace. Thin wrapper over `manageAuthProfiles`.
 *
 * Field-name conventions mirror the handler schema exactly:
 *   - `create` takes an optional `slug` for the new profile (the handler
 *     auto-derives one from display_name if omitted).
 *   - `get`, `test`, `delete` look profiles up by `auth_profile_slug`.
 *   - `update` takes the existing `auth_profile_slug` plus an optional
 *     new `slug` if the caller wants to rename.
 *   - Credentials use `credentials` (key/value) or `auth_data` (OAuth/browser
 *     session state).
 */

import type { Env } from "../../index";
import { manageAuthProfiles } from "../../tools/admin/manage_auth_profiles";
import type { ToolContext } from "../../tools/registry";
import type { AuthProfileKind as StoredAuthProfileKind } from "../../utils/auth-profiles";
import { createActionCaller, idArg } from "./action-call";

/** Kinds manageable through the SDK — the stored kinds minus the internal-only `interactive`. */
export type AuthProfileKind = Exclude<StoredAuthProfileKind, "interactive">;

export interface AuthProfileCreateInput {
	profile_kind: AuthProfileKind;
	connector_key: string;
	display_name: string;
	/** Optional stable slug for the new profile. Auto-derived when omitted. */
	slug?: string;
	credentials?: Record<string, string>;
	auth_data?: Record<string, unknown>;
	requested_scopes?: string[];
}

export interface AuthProfileUpdateInput {
	/** Identifies the profile to mutate. */
	auth_profile_slug: string;
	display_name?: string;
	/** Rename the profile. */
	slug?: string;
	credentials?: Record<string, string>;
	auth_data?: Record<string, unknown>;
	requested_scopes?: string[];
	status?: string;
	reconnect?: boolean;
}

export interface AuthProfilesNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: {
		connector_key?: string;
		provider?: string;
		profile_kind?: AuthProfileKind;
	}): Promise<unknown>;
	get(auth_profile_slug: string): Promise<unknown>;
	test(auth_profile_slug: string): Promise<unknown>;
	create(input: AuthProfileCreateInput): Promise<unknown>;
	update(input: AuthProfileUpdateInput): Promise<unknown>;
	delete(
		auth_profile_slug: string,
		options?: { force?: boolean },
	): Promise<unknown>;
}

export function buildAuthProfilesNamespace(
	ctx: ToolContext,
	env: Env,
): AuthProfilesNamespace {
	const { manage, method } = createActionCaller(
		manageAuthProfiles,
		env,
		ctx,
		"authProfiles",
	);

	return {
		manage,
		list: method("list_auth_profiles", { publicMethod: "list" }),
		get: method("get_auth_profile", {
			publicMethod: "get",
			mapArgs: (auth_profile_slug) => ({
				auth_profile_slug: idArg(
					"authProfiles.get",
					"auth_profile_slug",
					auth_profile_slug,
					"string",
				),
			}),
		}),
		test: method("test_auth_profile", {
			publicMethod: "test",
			mapArgs: (auth_profile_slug) => ({
				auth_profile_slug: idArg(
					"authProfiles.test",
					"auth_profile_slug",
					auth_profile_slug,
					"string",
				),
			}),
		}),
		create: method("create_auth_profile", { publicMethod: "create" }),
		update: method("update_auth_profile", { publicMethod: "update" }),
		delete: method("delete_auth_profile", {
			publicMethod: "delete",
			mapArgs: (auth_profile_slug, options) => ({
				auth_profile_slug: idArg(
					"authProfiles.delete",
					"auth_profile_slug",
					auth_profile_slug,
					"string",
				),
				...options,
			}),
		}),
	};
}

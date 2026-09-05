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

import type { ActionInput } from "@lobu/core/contracts/tools/action-input";
import type { ManageAuthProfilesArgs } from "@lobu/core/contracts/tools/manage-auth-profiles";
import type { Env } from "../../index";
import { manageAuthProfiles } from "../../tools/admin/manage_auth_profiles";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

// The `profile_kind` on list/create covers the four caller-manageable kinds
// only. The stored enum also has `interactive`, which the contract deliberately
// omits: interactive-connection setup mints those profiles itself.
export type AuthProfileListInput = ActionInput<
	ManageAuthProfilesArgs,
	"list_auth_profiles"
>;
export type AuthProfileCreateInput = ActionInput<
	ManageAuthProfilesArgs,
	"create_auth_profile"
>;
export type AuthProfileUpdateInput = ActionInput<
	ManageAuthProfilesArgs,
	"update_auth_profile"
>;
/** `delete` takes the slug positionally; the rest of the action rides in `options`. */
export type AuthProfileDeleteOptions = Omit<
	ActionInput<ManageAuthProfilesArgs, "delete_auth_profile">,
	"auth_profile_slug"
>;

export interface AuthProfilesNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: AuthProfileListInput): Promise<unknown>;
	get(auth_profile_slug: string): Promise<unknown>;
	test(auth_profile_slug: string): Promise<unknown>;
	create(input: AuthProfileCreateInput): Promise<unknown>;
	update(input: AuthProfileUpdateInput): Promise<unknown>;
	delete(
		auth_profile_slug: string,
		options?: AuthProfileDeleteOptions,
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

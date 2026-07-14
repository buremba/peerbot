import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";

const calls: Array<{ action: string; input?: Record<string, unknown> }> = [];
const watcherGets: Array<Record<string, unknown>> = [];

const captureAction = async (input: Record<string, unknown>) => {
	const { action, ...rest } = input;
	calls.push({ action: String(action), input: rest });
	return input;
};

mock.module("../../../tools/admin/manage_entity", () => ({
	manageEntity: captureAction,
}));
mock.module("../../../tools/admin/manage_feeds", () => ({
	manageFeeds: captureAction,
}));
mock.module("../../../tools/admin/manage_classifiers", () => ({
	manageClassifiers: captureAction,
}));
mock.module("../../../tools/admin/manage_schedules", () => ({
	manageSchedules: captureAction,
}));
mock.module("../../../tools/admin/manage_entity_schema", () => ({
	manageEntitySchema: captureAction,
}));
mock.module("../../../tools/admin/manage_connections", () => ({
	manageConnections: captureAction,
}));
mock.module("../../../tools/admin/manage_auth_profiles", () => ({
	manageAuthProfiles: captureAction,
}));

mock.module("../../../tools/get_watchers", () => ({
	getWatcher: async (input: Record<string, unknown>) => {
		watcherGets.push(input);
		return input;
	},
}));

mock.module("../../../tools/admin/manage_watchers", () => ({
	manageWatchers: captureAction,
	listWatchers: async () => undefined,
}));

const ctx = {} as ToolContext;
const env = {} as Env;

describe("ClientSDK object signature contract", () => {
	let builders: {
		entities: typeof import("../../../sandbox/namespaces/entities").buildEntitiesNamespace;
		feeds: typeof import("../../../sandbox/namespaces/feeds").buildFeedsNamespace;
		classifiers: typeof import("../../../sandbox/namespaces/classifiers").buildClassifiersNamespace;
		schedules: typeof import("../../../sandbox/namespaces/schedules").buildSchedulesNamespace;
		watchers: typeof import("../../../sandbox/namespaces/watchers").buildWatchersNamespace;
		entitySchema: typeof import("../../../sandbox/namespaces/entity-schema").buildEntitySchemaNamespace;
		connections: typeof import("../../../sandbox/namespaces/connections").buildConnectionsNamespace;
		authProfiles: typeof import("../../../sandbox/namespaces/auth-profiles").buildAuthProfilesNamespace;
	};

	beforeAll(async () => {
		const [
			entities,
			feeds,
			classifiers,
			schedules,
			watchers,
			entitySchema,
			connections,
			authProfiles,
		] =
			await Promise.all([
				import("../../../sandbox/namespaces/entities"),
				import("../../../sandbox/namespaces/feeds"),
				import("../../../sandbox/namespaces/classifiers"),
				import("../../../sandbox/namespaces/schedules"),
				import("../../../sandbox/namespaces/watchers"),
				import("../../../sandbox/namespaces/entity-schema"),
				import("../../../sandbox/namespaces/connections"),
				import("../../../sandbox/namespaces/auth-profiles"),
			]);
		builders = {
			entities: entities.buildEntitiesNamespace,
			feeds: feeds.buildFeedsNamespace,
			classifiers: classifiers.buildClassifiersNamespace,
			schedules: schedules.buildSchedulesNamespace,
			watchers: watchers.buildWatchersNamespace,
			entitySchema: entitySchema.buildEntitySchemaNamespace,
			connections: connections.buildConnectionsNamespace,
			authProfiles: authProfiles.buildAuthProfilesNamespace,
		};
	});

	it("forwards named id objects instead of treating them as positional ids", async () => {
		const entities = builders.entities(ctx, env);
		const feeds = builders.feeds(ctx, env);
		const classifiers = builders.classifiers(ctx, env);
		const schedules = builders.schedules(ctx, env);
		const watchers = builders.watchers(ctx, env);
		const entitySchema = builders.entitySchema(ctx, env);

		await entities.get({ entity_id: 11 });
		await entities.delete({ entity_id: 12, force_delete_tree: true });
		await feeds.get({ feed_id: 21, search_term: "urgent" });
		await feeds.trigger({ feed_id: 22 });
		await feeds.delete({ feed_id: 23 });
		await classifiers.delete({ classifier_id: 31 });
		await schedules.cancel({ id: "schedule-41" });
		await watchers.get({ watcher_id: "51" });
		await watchers.trigger({ watcher_id: "52" });
		await watchers.delete({ watcher_ids: ["53", "54"] });
		await entitySchema.deleteType({ slug: "company" });
		await entitySchema.deleteRelType({ slug: "works-at" });
		await entitySchema.listRules({ slug: "works-at" });

		expect(watcherGets).toEqual([{ watcher_id: "51" }]);
		expect(calls).toEqual([
			{ action: "get", input: { entity_id: 11 } },
			{
				action: "delete",
				input: { entity_id: 12, force_delete_tree: true },
			},
			{
				action: "read_feed",
				input: { feed_id: 21, search_term: "urgent" },
			},
			{ action: "trigger_feed", input: { feed_id: 22 } },
			{ action: "delete_feed", input: { feed_id: 23 } },
			{ action: "delete", input: { classifier_id: 31 } },
			{ action: "cancel", input: { id: "schedule-41" } },
			{ action: "trigger", input: { watcher_id: "52" } },
			{ action: "delete", input: { watcher_ids: ["53", "54"] } },
			{
				action: "delete",
				input: { schema_type: "entity_type", slug: "company" },
			},
			{
				action: "delete",
				input: { schema_type: "relationship_type", slug: "works-at" },
			},
			{
				action: "list_rules",
				input: { schema_type: "relationship_type", slug: "works-at" },
			},
		]);
	});

	it("explains positional connection and auth-profile arguments", async () => {
		const connections = builders.connections(ctx, env);
		const authProfiles = builders.authProfiles(ctx, env);

		// Placeholders are neutral (`<connection_id>`, `<auth_profile_slug>`), NOT
		// real-looking ids — a fresh agent must not copy a fabricated id verbatim.
		await expect(
			connections.reauthenticate({ connection_id: 418 } as never),
		).rejects.toThrow(
			"connections.reauthenticate expects a positional number. Call client.connections.reauthenticate(<connection_id>); do not pass an object.",
		);
		await expect(
			authProfiles.get({ auth_profile_slug: "google-calendar-account" } as never),
		).rejects.toThrow(
			"authProfiles.get expects a positional string. Call client.authProfiles.get('<auth_profile_slug>'); do not pass an object.",
		);
	});
});

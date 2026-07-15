import { describe, expect, it } from "bun:test";
import {
  BANNED_PATHS,
  METHOD_METADATA,
  type MethodAccess,
} from "../../../sandbox/method-metadata";
import { buildClientSDK } from "../../../sandbox/client-sdk";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";

const testEnv: Env = { ENVIRONMENT: "test" } as Env;
const testCtx: ToolContext = {
  organizationId: "test-org",
  userId: "test-user",
  memberRole: "owner",
  isAuthenticated: true,
  tokenType: "oauth",
  scopedToOrg: false,
  allowCrossOrg: true,
};

function enumerateSdkMethods(): { namespaceMethods: string[]; topLevelMethods: string[] } {
  const sdk = buildClientSDK(testCtx, testEnv);
  const namespaceMethods: string[] = [];
  const topLevelMethods: string[] = [];

  for (const [name, value] of Object.entries(sdk)) {
    if (typeof value === "function") {
      topLevelMethods.push(name);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    for (const method of Object.keys(value)) {
      namespaceMethods.push(`${name}.${method}`);
    }
  }

  return { namespaceMethods, topLevelMethods };
}

describe("method-metadata", () => {
  it("has metadata for every namespace method", () => {
    const { namespaceMethods } = enumerateSdkMethods();
    const missing = namespaceMethods.filter((path) => !(path in METHOD_METADATA));
    expect(missing).toEqual([]);
  });

  it("has a runtime method for every namespace metadata entry (no phantom docs)", () => {
    // The reverse direction: a METHOD_METADATA key without a runtime method is
    // dead documentation that search_sdk advertises but the sandbox rejects
    // (e.g. the retired `watchers.upgrade`).
    const { namespaceMethods, topLevelMethods } = enumerateSdkMethods();
    const runtime = new Set([...namespaceMethods, ...topLevelMethods]);
    const phantom = Object.keys(METHOD_METADATA).filter(
      (path) => !runtime.has(path)
    );
    expect(phantom).toEqual([]);
  });

  it("has entries for top-level methods", () => {
    const { topLevelMethods } = enumerateSdkMethods();
    for (const m of topLevelMethods) {
      expect(METHOD_METADATA).toHaveProperty(m);
    }
  });

  it("has valid access levels on every entry", () => {
    const valid: MethodAccess[] = ["read", "write", "external", "admin"];
    for (const [path, meta] of Object.entries(METHOD_METADATA)) {
      expect(valid).toContain(meta.access);
      expect(meta.summary.length).toBeGreaterThan(0);
      if (meta.example) {
        expect(meta.example).toContain("client.");
      }
      void path;
    }
  });

  it("uses dotted path keys", () => {
    for (const path of Object.keys(METHOD_METADATA)) {
      expect(path).toMatch(/^[a-zA-Z]+(\.[a-zA-Z]+)?$/);
    }
  });

  it("never exposes banned paths", () => {
    for (const banned of BANNED_PATHS) {
      expect(METHOD_METADATA).not.toHaveProperty(banned);
    }
  });

  it("classifies external side-effects correctly for known methods", () => {
    expect(METHOD_METADATA["operations.execute"].access).toBe("external");
    expect(METHOD_METADATA["feeds.trigger"].access).toBe("external");
    expect(METHOD_METADATA["watchers.trigger"].access).toBe("external");
    expect(METHOD_METADATA["connections.test"].access).toBe("external");
    expect(METHOD_METADATA["authProfiles.test"].access).toBe("external");
  });

  it("classifies reads correctly for known methods", () => {
    expect(METHOD_METADATA["entities.list"].access).toBe("read");
    expect(METHOD_METADATA["watchers.list"].access).toBe("read");
    expect(METHOD_METADATA["organizations.list"].access).toBe("read");
  });

  it("does not claim SQL positional parameters in the query example", () => {
    const example = METHOD_METADATA.query.example ?? "";
    expect(example).not.toMatch(/\$\d+/);
  });

	it("documents object signatures for named id methods", () => {
		const objectSignatureMethods = [
			"entities.get",
			"entities.delete",
			"feeds.get",
			"feeds.trigger",
			"feeds.delete",
			"classifiers.delete",
			"schedules.cancel",
			"watchers.get",
			"watchers.trigger",
			"watchers.delete",
			"entitySchema.deleteType",
			"entitySchema.deleteRelType",
			"entitySchema.listRules",
		];

		for (const path of objectSignatureMethods) {
			expect(METHOD_METADATA[path]?.example, path).toMatch(/\(\{/);
		}
	});

	it("teaches the two-hop create-type-first pattern with the right constructors", () => {
		// entities.create must point at entitySchema.createType (the type must
		// exist first) — the multi-step precondition agents otherwise miss.
		const create = METHOD_METADATA["entities.create"];
		expect(create.summary).toContain("entitySchema.createType");
		expect(create.usageExample ?? "").toContain("entitySchema.createType");
		// The documented error contract must be REAL: run_sdk surfaces the
		// unknown-type ToolUserError as a ValidationError. `EntityTypeNotFound`
		// is not a public error — recovery keyed to it could never fire.
		expect(create.throws ?? []).toContain("ValidationError");
		expect(create.throws ?? []).not.toContain("EntityTypeNotFound");
		expect(create.summary).not.toContain("EntityTypeNotFound");
		// The ensure step tolerates only the coded duplicate 409 (multi-replica
		// race), so a concurrent caller doesn't abort the advertised flow.
		expect(create.usageExample ?? "").toContain("entity_type_exists");

		// entities.link must name entitySchema.createRelType as the relationship-
		// type constructor. addRule does NOT create a type (it only restricts the
		// allowed source/target pairs), so it must never be presented as the
		// constructor — that was a factual error the guidance is meant to prevent.
		const link = METHOD_METADATA["entities.link"];
		expect(link.summary).toContain("entitySchema.createRelType");
		expect(link.summary).not.toMatch(
			/call `?entitySchema\.addRule`? first|addRule.*\(or createRelType\)/
		);
		// The copy-paste usage example must embody the full two-hop flow (ensure
		// the rel-type, then link) — not just mention it — so a pasted example
		// can't reproduce the missing-type stall it's meant to prevent.
		const linkExample = link.usageExample ?? "";
		expect(linkExample).toContain("listRelTypes");
		expect(linkExample).toContain("createRelType");
		expect(linkExample).toContain("entities.link");
		// Same multi-replica race safety as entities.create: tolerate only the
		// coded relationship_type_exists 409, don't swallow every error.
		expect(linkExample).toContain("relationship_type_exists");
	});

	it("teaches the connect→feed two-hop so setup actually collects data", () => {
		// connections.connect alone syncs nothing — the agent must then create a
		// feed on the returned connection_id. This is the connect-website eval gap:
		// agents discover the connector but stall before the feed. Both entries
		// must name the sibling call and thread connection_id.
		const connect = METHOD_METADATA["connections.connect"];
		expect(connect.summary).toContain("connection_id");
		expect(connect.summary).toMatch(/create a feed|feeds\.create/);
		// connect() does NOT always return a usable connection_id: for the
		// setup_required continuation the field is OPTIONAL. The summary must
		// describe it as outcome-dependent (not promise an id unconditionally,
		// and not claim setup_required NEVER has one), so an agent waits for a
		// real id before calling feeds.create.
		expect(connect.summary).toContain("setup_required");
		expect(connect.summary).toMatch(/optional/i);
		expect(connect.summary).not.toMatch(/NO connection exists/i);
		const connectExample = connect.usageExample ?? "";
		expect(connectExample).toContain("connections.connect");
		expect(connectExample).toContain("feeds.create");
		expect(connectExample).toContain("connection_id");
		expect(connectExample).toContain("feed_key");
		// The website 'pages' config must use the REAL connector keys — assert the
		// executable expression itself passes urls: [...] (or sitemap_url), not
		// just that the word appears in a comment. A made-up key (config:{} /
		// {url}) creates a feed that collects zero events.
		expect(connectExample).toMatch(/config:\s*\{\s*(urls:\s*\[|sitemap_url:)/);

		// feeds.create must document the connection_id + feed_key it needs and
		// point at how to discover the config shape — not leave the agent guessing.
		const feed = METHOD_METADATA["feeds.create"];
		expect(feed.summary).toContain("connection_id");
		expect(feed.summary).toContain("feed_key");
		expect(feed.signature ?? "").toContain("connection_id");
		expect(feed.example ?? "").toContain("feed_key");
	});
});

import { describe, expect, test } from "bun:test";
import {
  type Agent,
  type AuthProfile,
  type ConnectorClassExport,
  connectorFromFile,
  context,
  defineAgent,
  defineAuthProfile,
  defineAutomation,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineRelationshipType,
  type EntityType,
  every,
  on,
  reactionFromFile,
} from "../define.js";
import { isSecretRef, secret } from "../secret.js";

describe("secret", () => {
  test("builds a resolvable ref and narrows", () => {
    const s = secret("GITHUB_TOKEN");
    expect(s).toEqual({ $secret: "GITHUB_TOKEN" });
    expect(isSecretRef(s)).toBe(true);
    expect(isSecretRef({})).toBe(false);
    expect(() => secret("")).toThrow();
  });
});

describe("authoring producers", () => {
  test("define* brand their output and preserve config", () => {
    const person = defineEntityType({ key: "person", name: "Person" });
    expect(person.kind).toBe("entityType");
    expect(person.key).toBe("person");

    const worksAt = defineRelationshipType({
      key: "works_at",
      rules: [{ source: person, target: "org" }],
    });
    expect(worksAt.kind).toBe("relationshipType");
    // typed handle: the EntityType object is usable as a rule source
    expect((worksAt.rules?.[0]?.source as EntityType).key).toBe("person");
  });

  test("agent + automation use typed handles", () => {
    const crm = defineAgent({
      id: "crm",
      providers: [
        { model: "claude-sonnet-4-6", key: secret("ANTHROPIC_API_KEY") },
      ],
    });
    expect(crm.kind).toBe("agent");
    expect(isSecretRef(crm.providers?.[0]?.key)).toBe(true);

    const w = defineAutomation({
      agent: crm,
      slug: "health",
      prompt: "assess",
    });
    expect(w.kind).toBe("automation");
    expect((w.agent as Agent).id).toBe("crm");
  });

  test("reactionFromFile carries the path as a branded marker (no import)", () => {
    const r = reactionFromFile("./reactions/health.reaction.ts");
    expect(r).toEqual({
      kind: "reactionSource",
      path: "./reactions/health.reaction.ts",
    });

    const w = defineAutomation({
      agent: "crm",
      slug: "health",
      prompt: "assess",
      reaction: reactionFromFile("./reactions/health.reaction.ts"),
    });
    expect(w.reaction?.kind).toBe("reactionSource");
    expect(w.reaction?.path).toBe("./reactions/health.reaction.ts");
  });

  test("connectorFromFile carries the path as a branded marker (no import)", () => {
    // Bare (untyped) form still works — the generic defaults.
    const bare = connectorFromFile("./github-issues.connector.ts");
    expect(bare).toEqual({
      kind: "connectorSource",
      path: "./github-issues.connector.ts",
    });

    // The opt-in typed form produces the SAME runtime marker — the generic is
    // erased, carrying only the path as data (no module import at eval time).
    const typed = connectorFromFile<ConnectorClassExport>(
      "./github-issues.connector.ts"
    );
    expect(typed).toEqual(bare);

    const project = defineConfig({
      agents: [defineAgent({ id: "crm" })],
      connectors: [bare],
    });
    expect(project.connectors?.[0]?.kind).toBe("connectorSource");
    expect(project.connectors?.[0]?.path).toBe("./github-issues.connector.ts");
  });

  test("connection + auth profile wire by handle", () => {
    const auth = defineAuthProfile({
      slug: "gh-app",
      connector: "github",
      authKind: "oauth_app",
      credentials: { clientSecret: secret("GH_SECRET") },
    });
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      authProfile: auth,
      feeds: [{ feed: "stars", schedule: "0 */6 * * *" }],
    });
    expect(conn.kind).toBe("connection");
    expect((conn.authProfile as AuthProfile).slug).toBe("gh-app");
    expect(isSecretRef(auth.credentials?.clientSecret)).toBe(true);
  });

  test("on() emits the canonical connector event trigger", () => {
    const t = on("slack", "message.created", {
      match: { channel_id: "#support" },
    });
    expect(t).toEqual({
      kind: "event",
      source: "connector",
      connector_key: "slack",
      event_types: ["message.created"],
      match: { channel_id: "#support" },
    });
    // Downstream normalization owns defaults; the shorthand must not bake them.
    expect(t.execution).toBeUndefined();
  });

  test("on() accepts several event types and dedupes", () => {
    expect(
      on("jira", ["issue.created", "issue.updated", "issue.created"])
        .event_types
    ).toEqual(["issue.created", "issue.updated"]);
  });

  test("on() wires a connection handle and overridable execution fields", () => {
    const conn = defineConnection({ slug: "support", connector: "slack" });
    const t = on("slack", "message.created", {
      connection: conn,
      execution: "window",
      active_run: "coalesce",
    });
    expect(t.connection).toBe(conn);
    expect(t.execution).toBe("window");
    expect(t.active_run).toBe("coalesce");
  });

  test("every() emits the canonical schedule trigger", () => {
    expect(every("0 9 * * 1", { timezone: "Europe/Istanbul" })).toEqual({
      kind: "schedule",
      cron: "0 9 * * 1",
      timezone: "Europe/Istanbul",
    });
    expect(every("0 9 * * 1")).toEqual({
      kind: "schedule",
      cron: "0 9 * * 1",
    });
  });

  test("context() emits a context-only SQL source", () => {
    expect(context("SELECT id, name FROM entities")).toEqual({
      query: "SELECT id, name FROM entities",
      context: true,
    });
  });

  test("defineConfig aggregates the project manifest", () => {
    const crm = defineAgent({ id: "crm" });
    const project = defineConfig({ org: "lobu-crm", agents: [crm] });
    expect(project.kind).toBe("project");
    expect(project.org).toBe("lobu-crm");
    expect(project.agents).toHaveLength(1);
    expect(project.agents[0]?.id).toBe("crm");
  });
});

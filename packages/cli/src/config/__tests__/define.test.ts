import { describe, expect, test } from "bun:test";
import {
  type Agent,
  type AuthProfile,
  type ConnectorClassExport,
  connectorFromFile,
  defineAgent,
  defineAuthProfile,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  type EntityType,
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

  test("agent + watcher use typed handles", () => {
    const crm = defineAgent({
      id: "crm",
      providers: [
        { model: "claude-sonnet-4-6", key: secret("ANTHROPIC_API_KEY") },
      ],
    });
    expect(crm.kind).toBe("agent");
    expect(isSecretRef(crm.providers?.[0]?.key)).toBe(true);

    const w = defineWatcher({
      agent: crm,
      slug: "health",
      prompt: "assess",
    });
    expect(w.kind).toBe("watcher");
    expect((w.agent as Agent).id).toBe("crm");
  });

  test("reactionFromFile carries the path as a branded marker (no import)", () => {
    const r = reactionFromFile("./reactions/health.reaction.ts");
    expect(r).toEqual({
      kind: "reactionSource",
      path: "./reactions/health.reaction.ts",
    });

    const w = defineWatcher({
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

  test("defineConfig aggregates the project manifest", () => {
    const crm = defineAgent({ id: "crm" });
    const project = defineConfig({ org: "lobu-crm", agents: [crm] });
    expect(project.kind).toBe("project");
    expect(project.org).toBe("lobu-crm");
    expect(project.agents).toHaveLength(1);
    expect(project.agents[0]?.id).toBe("crm");
  });
});

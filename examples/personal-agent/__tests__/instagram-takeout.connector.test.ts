import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let InstagramTakeoutConnector: any;
let normalizeInstagramUsername: any;
let usernameFromProfileUrl: any;
let INSTAGRAM_IDENTITY: any;

beforeAll(async () => {
  const connectorMod = await import("../instagram-takeout.connector");
  InstagramTakeoutConnector = connectorMod.default;
  const identityMod = await import("../instagram-identity");
  normalizeInstagramUsername = identityMod.normalizeInstagramUsername;
  usernameFromProfileUrl = identityMod.usernameFromProfileUrl;
  INSTAGRAM_IDENTITY = identityMod.INSTAGRAM_IDENTITY;
});

describe("instagram-identity normalization", () => {
  test("normalizeInstagramUsername strips @, lowercases, enforces handle grammar", () => {
    expect(normalizeInstagramUsername("@Jack")).toBe("jack");
    expect(normalizeInstagramUsername("some.user_1")).toBe("some.user_1");
    expect(normalizeInstagramUsername(" MixedCase ")).toBe("mixedcase");
    expect(normalizeInstagramUsername("a".repeat(31))).toBe(null);
    expect(normalizeInstagramUsername("has space")).toBe(null);
    expect(normalizeInstagramUsername("bad/slash")).toBe(null);
    expect(normalizeInstagramUsername("")).toBe(null);
    expect(normalizeInstagramUsername(null)).toBe(null);
  });

  test("reserved non-profile path segments are rejected (no post/reel forks)", () => {
    for (const seg of [
      "p",
      "reel",
      "reels",
      "stories",
      "explore",
      "accounts",
    ]) {
      expect(normalizeInstagramUsername(seg)).toBe(null);
    }
  });

  test("usernameFromProfileUrl recovers the normalized handle from a profile link", () => {
    expect(usernameFromProfileUrl("https://www.instagram.com/Jack")).toBe(
      "jack"
    );
    expect(
      usernameFromProfileUrl("https://instagram.com/some.user_1?hl=en")
    ).toBe("some.user_1");
    // A shared-post link resolves to a reserved segment -> not a person.
    expect(usernameFromProfileUrl("https://instagram.com/p/Cabc123/")).toBe(
      null
    );
    expect(usernameFromProfileUrl("not-a-link")).toBe(null);
    expect(usernameFromProfileUrl(null)).toBe(null);
  });

  test("namespace is the IG-internal username key", () => {
    expect(INSTAGRAM_IDENTITY.USERNAME).toBe("ig_username");
  });
});

describe("InstagramTakeoutConnector identity attributions", () => {
  test("connections feed attributes `about` a person keyed EQUAL-WEIGHT on ig_username", () => {
    const def = new InstagramTakeoutConnector().definition;
    for (const kind of [
      "follower",
      "following",
      "blocked_profiles",
      "restricted_profiles",
    ] as const) {
      const attr = def.feeds.connections.eventKinds[kind].attributions?.[0];
      expect(attr).toBeDefined();
      expect(attr.role).toBe("about");
      expect(attr.autoCreate).toBe(true);
      expect(attr.target.entityType).toBe("person");
      const id = attr.target.identities[0];
      expect(id).toMatchObject({
        namespace: "ig_username",
        eventPath: "metadata.username",
      });
      // Username is user-changeable -> a soft key, NEVER primary (equal-weight,
      // like linkedin_slug). A primary would fork the same handle across feeds.
      expect(id.primary).toBeUndefined();
    }
  });

  test("auto-create is gated on a resolvable username (no id-less forks)", () => {
    const def = new InstagramTakeoutConnector().definition;
    const attr = def.feeds.connections.eventKinds.follower.attributions[0];
    expect(attr.target.createWhen).toEqual({
      path: "metadata.username",
      exists: true,
    });
  });
});

describe("InstagramTakeoutConnector emits metadata the attributions resolve", () => {
  function writeConnectionsFixture(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ig-takeout-"));
    const root = path.join(dir, "connections", "followers_and_following");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "followers_1.html"),
      `<html><body><main>
        <a href="https://www.instagram.com/aykut.gk">Aykut Gedik</a>
        <a href="https://www.instagram.com/p/Cxyz/">a shared post</a>
      </main></body></html>`
    );
    // Same handle appears in following.html -> must fold onto ONE person.
    writeFileSync(
      path.join(root, "following.html"),
      `<html><body><main>
        <a href="https://www.instagram.com/Aykut.GK">Aykut Gedik</a>
      </main></body></html>`
    );
    return dir;
  }

  test("a follower row emits a normalized username the identity keys on", () => {
    const dir = writeConnectionsFixture();
    const connector = new InstagramTakeoutConnector();
    const events = (connector as any).readConnectionEvents(dir);
    const followers = events.filter(
      (e: any) =>
        e.origin_type === "follower" && e.author_name === "Aykut Gedik"
    );
    expect(followers).toHaveLength(1);
    expect(resolvePath(followers[0], "metadata.username")).toBe("aykut.gk");
    expect(resolvePath(followers[0], "metadata.platform")).toBe("instagram");
  });

  test("the same handle in followers AND following normalizes to ONE key (dedup)", () => {
    const dir = writeConnectionsFixture();
    const connector = new InstagramTakeoutConnector();
    const events = (connector as any).readConnectionEvents(dir);
    const usernames = events
      .filter((e: any) => ["follower", "following"].includes(e.origin_type))
      .map((e: any) => resolvePath(e, "metadata.username"))
      .filter(Boolean);
    // "aykut.gk" (follower) and "Aykut.GK" (following) collapse to one value.
    expect(new Set(usernames)).toEqual(new Set(["aykut.gk"]));
  });

  test("a non-profile link (shared post) emits no username -> mint-gated off", () => {
    const dir = writeConnectionsFixture();
    const connector = new InstagramTakeoutConnector();
    const events = (connector as any).readConnectionEvents(dir);
    const postRow = events.find((e: any) => e.author_name === "a shared post");
    expect(postRow).toBeDefined();
    // username is undefined -> createWhen(exists) false -> never mints a person.
    expect(resolvePath(postRow, "metadata.username")).toBeUndefined();
  });
});

function resolvePath(obj: any, dotPath: string): unknown {
  return dotPath.split(".").reduce((acc, key) => acc?.[key], obj);
}

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let TwitterTakeoutConnector: any;
let normalizeXUserId: any;
let normalizeXHandle: any;
let handleFromUserLink: any;
let X_IDENTITY: any;

beforeAll(async () => {
  const connectorMod = await import("../twitter-takeout.connector");
  TwitterTakeoutConnector = connectorMod.default;
  const identityMod = await import("../x-identity");
  normalizeXUserId = identityMod.normalizeXUserId;
  normalizeXHandle = identityMod.normalizeXHandle;
  handleFromUserLink = identityMod.handleFromUserLink;
  X_IDENTITY = identityMod.X_IDENTITY;
});

describe("x-identity normalization", () => {
  test("normalizeXUserId keeps digits, strips leading zeros, rejects junk", () => {
    expect(normalizeXUserId("44196397")).toBe("44196397");
    expect(normalizeXUserId("007")).toBe("7");
    expect(normalizeXUserId(" 123 ")).toBe("123");
    expect(normalizeXUserId("abc")).toBe(null);
    expect(normalizeXUserId("")).toBe(null);
    expect(normalizeXUserId(null)).toBe(null);
    expect(normalizeXUserId(undefined)).toBe(null);
  });

  test("normalizeXHandle strips @, lowercases, enforces 1–15 [a-z0-9_]", () => {
    expect(normalizeXHandle("@Jack")).toBe("jack");
    expect(normalizeXHandle("elonmusk")).toBe("elonmusk");
    expect(normalizeXHandle("a".repeat(16))).toBe(null);
    expect(normalizeXHandle("has space")).toBe(null);
    expect(normalizeXHandle("")).toBe(null);
  });

  test("handleFromUserLink recovers the normalized handle from a profile link", () => {
    expect(handleFromUserLink("https://twitter.com/Jack")).toBe("jack");
    expect(handleFromUserLink("https://x.com/elonmusk?ref=1")).toBe("elonmusk");
    expect(handleFromUserLink("not-a-link")).toBe(null);
    expect(handleFromUserLink(null)).toBe(null);
  });

  test("namespaces match the built-in @lobu/connectors x-identity verbatim", () => {
    // The resolver matches on the namespace STRING across the connector/
    // connection boundary — these MUST equal the built-in values or takeout
    // people will never fuse with the live X connector's people.
    expect(X_IDENTITY.USER_ID).toBe("x_user_id");
    expect(X_IDENTITY.HANDLE).toBe("x_handle");
  });
});

describe("TwitterTakeoutConnector identity attributions", () => {
  test("reply targets attribute `about` a person keyed primary on x_user_id", () => {
    const def = new TwitterTakeoutConnector().definition;
    const attr = def.feeds.tweets.eventKinds.reply.attributions?.[0];
    expect(attr).toBeDefined();
    expect(attr.role).toBe("about");
    expect(attr.autoCreate).toBe(true);
    expect(attr.target.entityType).toBe("person");

    const uid = attr.target.identities.find(
      (i: { namespace: string }) => i.namespace === X_IDENTITY.USER_ID
    );
    expect(uid).toMatchObject({
      namespace: "x_user_id",
      eventPath: "metadata.in_reply_to_user_id",
      primary: true,
    });
    const handle = attr.target.identities.find(
      (i: { namespace: string }) => i.namespace === X_IDENTITY.HANDLE
    );
    expect(handle).toMatchObject({
      namespace: "x_handle",
      eventPath: "metadata.in_reply_to_screen_name",
    });
    // The handle is a soft key — only the numeric id is primary.
    expect(handle.primary).toBeUndefined();
  });

  test("DMs attribute BOTH parties match-only (never mint from a raw id)", () => {
    const def = new TwitterTakeoutConnector().definition;
    const rules = def.feeds.messages.eventKinds.dm_message.attributions;
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.autoCreate).toBe(false);
      expect(rule.target.identities[0].namespace).toBe("x_user_id");
      expect(rule.target.identities[0].matchOnly).toBe(true);
    }
    expect(rules[0].target.identities[0].eventPath).toBe("metadata.sender_id");
    expect(rules[1].target.identities[0].eventPath).toBe(
      "metadata.recipient_id"
    );
  });

  test("followers/following mint a person keyed primary on x_user_id", () => {
    const def = new TwitterTakeoutConnector().definition;
    for (const feed of ["followers", "following"] as const) {
      const kind = feed === "followers" ? "follower" : "following";
      const attr = def.feeds[feed].eventKinds[kind].attributions?.[0];
      expect(attr.autoCreate).toBe(true);
      expect(attr.target.identities[0]).toMatchObject({
        namespace: "x_user_id",
        eventPath: "metadata.account_id",
        primary: true,
      });
    }
  });

  test("auto-create is gated on the numeric id (no handle-only forks)", () => {
    // A handle-only row (no numeric id) must MATCH by handle but never MINT —
    // a person with no primary x_user_id can't merge with a later live-X event
    // that carries the real id, so minting one forks a permanent duplicate.
    const def = new TwitterTakeoutConnector().definition;

    const reply = def.feeds.tweets.eventKinds.reply.attributions[0];
    expect(reply.autoCreate).toBe(true);
    expect(reply.target.createWhen).toEqual({
      path: "metadata.in_reply_to_user_id",
      exists: true,
    });

    for (const feed of ["followers", "following"] as const) {
      const kind = feed === "followers" ? "follower" : "following";
      const attr = def.feeds[feed].eventKinds[kind].attributions[0];
      expect(attr.target.createWhen).toEqual({
        path: "metadata.account_id",
        exists: true,
      });
    }
  });

  test("a follow row with only a userLink (no accountId) still emits, gated off mint", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "x-takeout-"));
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir);
    writeFileSync(
      path.join(dataDir, "follower.js"),
      `window.YTD.follower.part0 = ${JSON.stringify([
        { follower: { userLink: "https://twitter.com/handleonly" } },
      ])}`
    );

    const connector = new TwitterTakeoutConnector();
    const events = (connector as any).readFollowEvents(dataDir, "follower");
    expect(events).toHaveLength(1);
    const [event] = events;
    // No account_id -> createWhen(exists) is false -> matches by handle only.
    expect(resolvePath(event, "metadata.account_id")).toBeUndefined();
    expect(resolvePath(event, "metadata.handle")).toBe("handleonly");
  });
});

describe("TwitterTakeoutConnector emits metadata the attributions resolve", () => {
  test("a reply row emits normalized handle + numeric id the identity keys on", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "x-takeout-"));
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir);
    // Twitter archive files are `window.YTD.tweets.part0 = [ ... ]` JS.
    writeFileSync(
      path.join(dataDir, "tweets.js"),
      `window.YTD.tweets.part0 = ${JSON.stringify([
        {
          tweet: {
            id_str: "1700000000000000001",
            full_text: "@Jack hey there",
            created_at: "Wed Oct 04 12:00:00 +0000 2023",
            in_reply_to_status_id_str: "1699000000000000000",
            in_reply_to_user_id_str: "12",
            in_reply_to_screen_name: "Jack",
          },
        },
      ])}`
    );

    const connector = new TwitterTakeoutConnector();
    const events = (connector as any).readTweetEvents(dataDir);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.origin_type).toBe("reply");

    const attr =
      connector.definition.feeds.tweets.eventKinds.reply.attributions[0];
    for (const identity of attr.target.identities) {
      expect(resolvePath(event, identity.eventPath)).toBeTruthy();
    }
    // Handle is emitted already-canonical (server won't run the normalizer).
    expect(resolvePath(event, "metadata.in_reply_to_screen_name")).toBe("jack");
    // Raw display value preserved separately.
    expect(resolvePath(event, "metadata.in_reply_to_screen_name_raw")).toBe(
      "Jack"
    );
    expect(resolvePath(event, "metadata.in_reply_to_user_id")).toBe("12");
  });

  test("a following row emits account_id + handle the identity keys on", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "x-takeout-"));
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir);
    writeFileSync(
      path.join(dataDir, "following.js"),
      `window.YTD.following.part0 = ${JSON.stringify([
        {
          following: {
            accountId: "44196397",
            userLink: "https://twitter.com/elonmusk",
          },
        },
      ])}`
    );

    const connector = new TwitterTakeoutConnector();
    const events = (connector as any).readFollowEvents(dataDir, "following");
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.origin_type).toBe("following");
    expect(resolvePath(event, "metadata.account_id")).toBe("44196397");
    expect(resolvePath(event, "metadata.handle")).toBe("elonmusk");
  });
});

function resolvePath(obj: any, dotPath: string): unknown {
  return dotPath.split(".").reduce((acc, key) => acc?.[key], obj);
}

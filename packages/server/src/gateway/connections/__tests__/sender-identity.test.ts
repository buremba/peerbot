/**
 * Unit contract for `buildSenderIdentity` — the connector-facing edge that turns
 * a raw inbound chat author into the normalized identity spec the core resolver
 * (`resolveSenderIdentity`) consumes. Pure (no DB): asserts the drop rules that
 * keep a malformed/bot/unknown-platform author from ever being attributed, and
 * the exact spec shape for a valid Slack sender.
 */

import { describe, expect, test } from "bun:test";
import { SLACK_IDENTITY, normalizeSlackUserId } from "@lobu/connectors/slack-identity";
import { buildSenderIdentity } from "../sender-identity.js";

const TEAM = "T1ACME";
const USER = "U1ALICE";

describe("buildSenderIdentity", () => {
  test("a bot post never attributes (returns null)", () => {
    expect(
      buildSenderIdentity({ platform: "slack", teamId: TEAM, authorId: USER, isBot: true }),
    ).toBeNull();
  });

  test("an unknown platform has no enforced sender model (returns null)", () => {
    expect(
      buildSenderIdentity({ platform: "telegram", teamId: TEAM, authorId: USER, isBot: false }),
    ).toBeNull();
  });

  test("a team-less Slack author is dropped (no malformed, non-workspace-scoped key)", () => {
    expect(
      buildSenderIdentity({ platform: "slack", teamId: null, authorId: USER, isBot: false }),
    ).toBeNull();
  });

  test("a missing author id is dropped", () => {
    expect(
      buildSenderIdentity({ platform: "slack", teamId: TEAM, authorId: null, isBot: false }),
    ).toBeNull();
  });

  test("a valid non-bot Slack sender yields the team-scoped slack_user_id spec, minting a person", () => {
    const spec = buildSenderIdentity({
      platform: "slack",
      teamId: TEAM,
      authorId: USER,
      isBot: false,
    });
    expect(spec).not.toBeNull();
    expect(spec?.mintEntityType).toBe("person");
    expect(spec?.identities).toEqual([
      {
        namespace: SLACK_IDENTITY.USER_ID,
        // The exact team-scoped key the ACL sync / entity-link path store under.
        identifier: normalizeSlackUserId(TEAM, USER) as string,
        matchOnly: false,
        primary: false,
      },
    ]);
  });
});

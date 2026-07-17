import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  BehaviorEventTriggerSchema,
  BehaviorScheduleTriggerSchema,
  WatcherSourceSchema,
} from "../contracts/tools/manage-behaviors";

const query = "SELECT id, payload_text FROM events ORDER BY occurred_at DESC";

describe("behavior event trigger", () => {
  test("keeps activation separate from Behavior context sources", () => {
    const trigger = {
      kind: "event",
      connector_key: "github",
      connection_id: 42,
      event_types: ["pull_request.created", "state.merged"],
      match: {
        resource_ref: "github:pull_request:lobu-ai/lobu#208",
      },
      execution: "turn",
    };
    expect(Value.Check(BehaviorEventTriggerSchema, trigger)).toBe(true);
    expect(
      Value.Check(WatcherSourceSchema, { name: "pull_request", query })
    ).toBe(true);
  });

  test("uses the same shape for a Slack Listen behavior", () => {
    expect(
      Value.Check(BehaviorEventTriggerSchema, {
        kind: "event",
        connector_key: "slack",
        connection_id: 17,
        event_types: ["message.created", "interaction.clicked"],
        match: { channel_id: "C123" },
        execution: "turn",
        active_run: "steer",
        output: "reply_to_source",
      })
    ).toBe(true);
  });

  test("rejects string connection ids instead of coercing identifiers", () => {
    expect(
      Value.Check(BehaviorEventTriggerSchema, {
        kind: "event",
        connector_key: "slack",
        connection_id: "17",
        event_types: ["message.created"],
      })
    ).toBe(false);
  });

  test("uses the existing watcher cadence as the schedule trigger projection", () => {
    expect(
      Value.Check(BehaviorScheduleTriggerSchema, {
        kind: "schedule",
        cron: "0 9 * * 1-5",
        timezone: "Europe/London",
        execution: "window",
        active_run: "coalesce",
        skip_if_unchanged: true,
      })
    ).toBe(true);
  });

  test("rejects provider-specific keys outside the normalized match object", () => {
    expect(
      Value.Check(BehaviorEventTriggerSchema, {
        kind: "event",
        connector_key: "github",
        event_types: ["pull_request.created"],
        repository: "lobu-ai/lobu",
      })
    ).toBe(false);
  });
});

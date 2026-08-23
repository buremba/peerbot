import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  AutomationEventTriggerSchema,
  AutomationScheduleTriggerSchema,
  AutomationSourceSchema,
  AutomationWorkspaceEventTriggerSchema,
  ManageAutomationsSchema,
  resolvedEventExecution,
} from "../contracts/tools/manage-automations";

const query = "SELECT id, payload_text FROM events ORDER BY occurred_at DESC";

describe("automation event trigger", () => {
  test("keeps activation separate from Automation context sources", () => {
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
    expect(Value.Check(AutomationEventTriggerSchema, trigger)).toBe(true);
    expect(
      Value.Check(AutomationSourceSchema, { name: "pull_request", query })
    ).toBe(true);
  });

  test("uses the same shape for a Slack Listen automation", () => {
    expect(
      Value.Check(AutomationEventTriggerSchema, {
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
      Value.Check(AutomationEventTriggerSchema, {
        kind: "event",
        connector_key: "slack",
        connection_id: "17",
        event_types: ["message.created"],
      })
    ).toBe(false);
  });

  test("uses a schedule trigger as the canonical cadence", () => {
    expect(
      Value.Check(AutomationScheduleTriggerSchema, {
        kind: "schedule",
        cron: "0 9 * * 1-5",
        timezone: "Europe/London",
        execution: "window",
        active_run: "coalesce",
        skip_if_unchanged: true,
      })
    ).toBe(true);
  });

  test("subscribes to durable workspace events through the shared event primitive", () => {
    expect(
      Value.Check(AutomationWorkspaceEventTriggerSchema, {
        kind: "event",
        source: "workspace",
        entity_type: "account",
        event_types: ["risk_detected"],
        match: { severity: "high", reviewed: false },
        execution: "window",
        active_run: "coalesce",
      })
    ).toBe(true);
    expect(
      Value.Check(AutomationWorkspaceEventTriggerSchema, {
        kind: "event",
        source: "workspace",
        connector_key: "github",
        event_types: ["risk_detected"],
      })
    ).toBe(false);
    expect(
      Value.Check(AutomationWorkspaceEventTriggerSchema, {
        kind: "event",
        event_types: ["risk_detected"],
      })
    ).toBe(false);
  });

  test("resolves event execution defaults from the selected source", () => {
    expect(
      resolvedEventExecution({
        kind: "event",
        connector_key: "github",
        event_types: ["pull_request.created"],
      })
    ).toBe("turn");
    expect(
      resolvedEventExecution({
        kind: "event",
        source: "workspace",
        event_types: ["risk_detected"],
      })
    ).toBe("window");
    expect(
      resolvedEventExecution({
        kind: "event",
        source: "workspace",
        event_types: ["risk_detected"],
        execution: "turn",
      })
    ).toBe("turn");
  });

  test("rejects unsupported queued schedule ticks", () => {
    expect(
      Value.Check(AutomationScheduleTriggerSchema, {
        kind: "schedule",
        cron: "0 9 * * 1-5",
        active_run: "queue",
      })
    ).toBe(false);
  });

  test("rejects the removed schedule and timezone compatibility inputs", () => {
    expect(
      Value.Check(ManageAutomationsSchema, {
        action: "update",
        automation_id: "1",
        schedule: "0 9 * * *",
        timezone: "Europe/London",
      })
    ).toBe(false);
  });

  test("rejects provider-specific keys outside the normalized match object", () => {
    expect(
      Value.Check(AutomationEventTriggerSchema, {
        kind: "event",
        connector_key: "github",
        event_types: ["pull_request.created"],
        repository: "lobu-ai/lobu",
      })
    ).toBe(false);
  });
});

describe("manage Automations agent assignment", () => {
  test("accepts null to clear agent_id and rejects an empty-string workaround", () => {
    expect(
      Value.Check(ManageAutomationsSchema, {
        action: "update",
        automation_id: "1",
        agent_id: null,
      })
    ).toBe(true);
    expect(
      Value.Check(ManageAutomationsSchema, {
        action: "update",
        automation_id: "1",
        agent_id: "",
      })
    ).toBe(false);
  });
});

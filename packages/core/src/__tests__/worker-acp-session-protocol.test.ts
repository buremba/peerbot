import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  AutomationPollPayloadSchema,
  HeartbeatRequestSchema,
} from "../contracts/worker/protocol";

describe("device Automation ACP session protocol", () => {
  test("accepts a same-device ACP resume id in the poll envelope", () => {
    expect(
      AutomationPollPayloadSchema.properties.context.properties.agent_session
        .properties.resume_session_id
    ).toBeDefined();
    expect(
      Value.Check(AutomationPollPayloadSchema, {
        automation: { id: "42", agent_kind: "codex" },
        event: { fired_at: "2026-08-23T10:00:00.000Z" },
        context: {
          device: { worker_id: "macos:test" },
          user: {},
          agent_session: {
            conversation_id: "agent_automation_42_run_99",
            mcp_url: "https://lobu.test/mcp/team",
            token: "run-token",
            expires_at: Date.now() + 60_000,
            resume_session_id: "acp-session-99",
          },
        },
      })
    ).toBe(true);
  });

  test("accepts a run-bound ACP session checkpoint on heartbeat", () => {
    expect(HeartbeatRequestSchema.properties.agent_session).toBeDefined();
    expect(
      Value.Check(HeartbeatRequestSchema, {
        run_id: 99,
        worker_id: "macos:test",
        agent_session: {
          protocol: "acp",
          agent_kind: "codex",
          session_id: "acp-session-99",
        },
      })
    ).toBe(true);
    expect(
      Value.Check(HeartbeatRequestSchema, {
        run_id: 99,
        worker_id: "macos:test",
        agent_session: {
          protocol: "acp-v2",
          agent_kind: "codex",
          session_id: "acp-session-99",
        },
      })
    ).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { buildDeviceChatPrompt } from "../contracts/worker/device-chat.js";
import {
  DeviceChatPollPayloadSchema,
  type DeviceChatPollPayload,
} from "../contracts/worker/protocol.js";

function payload(): DeviceChatPollPayload {
  return {
    chat: {
      agent_kind: "pi",
      message: "What changed today?",
      ephemeral_context: "Atlas has one urgent review.",
      history: [
        { role: "user", content: "Remember project Atlas." },
        { role: "assistant", content: "I will." },
      ],
      agent: {
        id: "agent-1",
        name: "Researcher",
        identity_md: "You are a careful researcher.",
        soul_md: "Prefer evidence.",
        user_md: "The user owns Atlas.",
      },
    },
    context: {
      device: { worker_id: "device-1" },
      user: { user_id: "user-1" },
      agent_session: {
        conversation_id: "conv-1",
        mcp_url: "https://lobu.test/mcp/acme",
        token: "run-token",
        expires_at: Date.now() + 60_000,
      },
    },
  };
}

describe("device chat contract", () => {
  test("the strict poll payload accepts the bounded device envelope", () => {
    expect(Value.Check(DeviceChatPollPayloadSchema, payload())).toBe(true);
  });

  test("the shared prompt carries agent layers, history, and the current turn", () => {
    const prompt = buildDeviceChatPrompt(payload());
    expect(prompt).toContain("Lobu agent Researcher");
    expect(prompt).toContain("## Identity\n\nYou are a careful researcher.");
    expect(prompt).toContain(
      "## Workspace context\n\nAtlas has one urgent review."
    );
    expect(prompt).toContain("User: Remember project Atlas.");
    expect(prompt).toContain("Assistant: I will.");
    expect(prompt).toContain("## Current user message\n\nWhat changed today?");
    expect(prompt).toContain("Return only the assistant reply on stdout");
  });
});

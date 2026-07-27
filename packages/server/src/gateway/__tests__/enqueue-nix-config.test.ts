/**
 * `nixConfig` must reach the ENQUEUED payload's top-level field — that is the
 * only place the spawn path reads it from (`deployment-manager` wraps the
 * worker in `nix-shell -p <packages>` off `messageData.nixConfig`).
 *
 * `buildMessagePayload` does that lift for callers that use it, but these two
 * paths hand-roll their `enqueueMessage` argument, so a resolved `nixConfig`
 * previously stayed nested inside `agentOptions` and was silently dropped.
 * These tests drive both paths with a capturing queue and assert the union
 * (per-request ∪ agent settings ∪ enabled skills) lands on `payload.nixConfig`
 * and NOT in `payload.agentOptions`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { MessagePayload } from "@lobu/core";
import { ChatInstanceManager } from "../connections/chat-instance-manager.js";

process.env.ENCRYPTION_KEY ||=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const AGENT_SETTINGS = {
  models: ["openai/gpt-5"],
  nixConfig: { packages: ["agent-pkg"] },
  skillsConfig: {
    skills: [
      {
        repo: "lobu/skills",
        name: "video",
        enabled: true,
        nixPackages: ["skill-pkg"],
      },
      {
        repo: "lobu/skills",
        name: "disabled-one",
        enabled: false,
        nixPackages: ["must-not-appear"],
      },
    ],
  },
};

function makeAgentSettingsStore() {
  return { getSettings: async () => AGENT_SETTINGS };
}

describe("enqueued payload carries the resolved nixConfig", () => {
  let enqueued: MessagePayload[];

  beforeEach(() => {
    enqueued = [];
  });

  test("routePlatformMessage lifts nixConfig out of agentOptions", async () => {
    const manager = Object.create(
      ChatInstanceManager.prototype,
    ) as ChatInstanceManager;

    // Only the seams routePlatformMessage touches — this asserts payload shape,
    // not connection selection or session persistence.
    Object.assign(manager, {
      services: {
        getSessionManager: () => ({ setSession: mock(async () => {}) }),
        getQueueProducer: () => ({
          enqueueMessage: mock(async (payload: MessagePayload) => {
            enqueued.push(payload);
          }),
        }),
        getAgentSettingsStore: makeAgentSettingsStore,
      },
      selectConnectionForPlatform: async () => ({
        id: "conn-1",
        organizationId: "org-1",
      }),
    });

    await manager.routePlatformMessage("telegram", "token-abcdefgh", "hi", {
      agentId: "agent-1",
      channelId: "chan-1",
      teamId: "team-1",
    });

    expect(enqueued).toHaveLength(1);
    const payload = enqueued[0]!;
    expect(payload.nixConfig?.packages).toEqual(["agent-pkg", "skill-pkg"]);
    // The worker reads the top-level field; a copy left in agentOptions would
    // mean the lift never happened.
    expect(
      (payload.agentOptions as Record<string, unknown> | undefined)?.nixConfig,
    ).toBeUndefined();
  });

  test("a disabled skill's packages never reach the payload", async () => {
    const manager = Object.create(
      ChatInstanceManager.prototype,
    ) as ChatInstanceManager;

    Object.assign(manager, {
      services: {
        getSessionManager: () => ({ setSession: mock(async () => {}) }),
        getQueueProducer: () => ({
          enqueueMessage: mock(async (payload: MessagePayload) => {
            enqueued.push(payload);
          }),
        }),
        getAgentSettingsStore: makeAgentSettingsStore,
      },
      selectConnectionForPlatform: async () => ({
        id: "conn-1",
        organizationId: "org-1",
      }),
    });

    await manager.routePlatformMessage("telegram", "token-abcdefgh", "hi", {
      agentId: "agent-1",
      channelId: "chan-1",
      teamId: "team-1",
    });

    const packages = enqueued[0]?.nixConfig?.packages;
    expect(packages).toBeDefined();
    expect(packages).not.toContain("must-not-appear");
  });
});

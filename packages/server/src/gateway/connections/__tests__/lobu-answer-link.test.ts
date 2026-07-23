import { describe, expect, spyOn, test } from "bun:test";
import * as workspaceModule from "../../../workspace/index.js";
import {
  appendMarkdownFooter,
  buildConversationFooterUrl,
} from "../lobu-answer-link.js";

function stubOrgSlug(slug: string | null) {
  return spyOn(workspaceModule, "getWorkspaceProvider").mockReturnValue({
    getOrgSlug: async () => slug,
  } as unknown as ReturnType<typeof workspaceModule.getWorkspaceProvider>);
}

describe("buildConversationFooterUrl", () => {
  test("builds the transcript URL from organization, agent, and conversation identity", async () => {
    const providerSpy = stubOrgSlug("acme/team");
    try {
      await expect(
        buildConversationFooterUrl({
          organizationId: "org-1",
          agentId: "agent one",
          conversationId: "slack:C1:169.1",
          publicGatewayUrl: "https://app.lobu.com/lobu",
        }),
      ).resolves.toBe(
        "https://app.lobu.com/acme%2Fteam/agents/agent%20one/conversations/slack%3AC1%3A169.1",
      );
    } finally {
      providerSpy.mockRestore();
    }
  });

  test("returns undefined without required link context and does not resolve the organization", async () => {
    const providerSpy = stubOrgSlug("acme");
    try {
      expect(
        await buildConversationFooterUrl({
          organizationId: undefined,
          agentId: "agent-1",
          conversationId: "slack:C1:1",
          publicGatewayUrl: "https://app.lobu.com",
        }),
      ).toBeUndefined();
      expect(
        await buildConversationFooterUrl({
          organizationId: "org-1",
          agentId: "agent-1",
          conversationId: "slack:C1:1",
          publicGatewayUrl: undefined,
        }),
      ).toBeUndefined();
      expect(providerSpy).not.toHaveBeenCalled();
    } finally {
      providerSpy.mockRestore();
    }
  });

  test("returns undefined when the organization slug cannot be resolved", async () => {
    const providerSpy = stubOrgSlug(null);
    try {
      await expect(
        buildConversationFooterUrl({
          organizationId: "org-1",
          agentId: "agent-1",
          conversationId: "slack:C1:1",
          publicGatewayUrl: "https://app.lobu.com",
        }),
      ).resolves.toBeUndefined();
    } finally {
      providerSpy.mockRestore();
    }
  });

  test("fails soft when organization lookup throws", async () => {
    const providerSpy = spyOn(
      workspaceModule,
      "getWorkspaceProvider",
    ).mockReturnValue({
      getOrgSlug: async () => {
        throw new Error("database unavailable");
      },
    } as unknown as ReturnType<typeof workspaceModule.getWorkspaceProvider>);
    try {
      await expect(
        buildConversationFooterUrl({
          organizationId: "org-1",
          agentId: "agent-1",
          conversationId: "slack:C1:1",
          publicGatewayUrl: "https://app.lobu.com",
        }),
      ).resolves.toBeUndefined();
    } finally {
      providerSpy.mockRestore();
    }
  });
});

describe("appendMarkdownFooter", () => {
  test("appends the footer once and trims trailing whitespace", () => {
    const url =
      "https://app.lobu.com/acme/agents/a/conversations/slack%3AC1%3A1";
    const once = appendMarkdownFooter("Hello\n ", url);

    expect(once).toBe(`Hello\n\n[View in Lobu ↗](${url})`);
    expect(appendMarkdownFooter(once, url)).toBe(once);
  });

  test("appends the footer when its label and URL only occur separately", () => {
    const url =
      "https://app.lobu.com/acme/agents/a/conversations/slack%3AC1%3A1";

    expect(appendMarkdownFooter(`View in Lobu ↗\n\n${url}`, url)).toBe(
      `View in Lobu ↗\n\n${url}\n\n[View in Lobu ↗](${url})`,
    );
  });
});

import { describe, expect, test } from "bun:test";
import type { InstructionContext } from "@lobu/core";
import { orgContext } from "../../../lobu/stores/org-context.js";
import { ChatIdentityInstructionProvider } from "../chat-identity-instruction-provider.js";
import { ChatInstanceManager } from "../chat-instance-manager.js";
import { PLATFORM_REGISTRY } from "../platforms/index.js";
import { SlackInstructionProvider } from "../slack-instruction-provider.js";

function ctx(overrides: Partial<InstructionContext>): InstructionContext {
  return {
    userId: "u1",
    agentId: "personal-agent",
    connectionId: "conn-1",
    sessionKey: "u1",
    workingDirectory: "/workspace",
    availableProjects: [],
    ...overrides,
  };
}

function managerReturning(
  connection: { metadata: Record<string, string> } | null,
  onGet?: (connectionId: string) => void
) {
  return {
    getConnection: async (connectionId: string) => {
      onGet?.(connectionId);
      return connection;
    },
  } as never;
}

describe("ChatIdentityInstructionProvider", () => {
  test("telegram gets identity and participant framing", async () => {
    const provider = new ChatIdentityInstructionProvider(
      managerReturning({
        metadata: {
          botUsername: "burembalobubot",
          botUserId: "8834276769",
        },
      }),
      "telegram"
    );

    const result = await provider.getInstructions(
      ctx({ organizationId: "buremba" })
    );

    expect(result).toContain("@burembalobubot");
    expect(result).toContain("8834276769");
    expect(result).toContain("Telegram");
    expect(result).toContain("participant in this conversation");
    expect(result).toContain('Address them as "you"');
  });

  test("uses the signed connection id without listing other connections", async () => {
    let requestedId: string | undefined;
    const manager = {
      getConnection: async (connectionId: string) => {
        requestedId = connectionId;
        return {
          metadata: { botUsername: "current-bot", botUserId: "CURRENT" },
        };
      },
      listConnections: async () => {
        throw new Error("must not guess from another connection");
      },
    } as never;
    const provider = new ChatIdentityInstructionProvider(manager, "telegram");

    const result = await provider.getInstructions(
      ctx({ organizationId: "acme", connectionId: "current-connection" })
    );

    expect(requestedId).toBe("current-connection");
    expect(result).toContain("@current-bot");
  });

  test("no connectionId on the turn: framing WITHOUT identity, by design", async () => {
    // Identity resolution deliberately has no agent+platform fallback: there is
    // exactly one InstructionContext construction site (`worker-dispatch/worker-gateway.ts`) and
    // it always carries the signed `connectionId`, which `enqueueUserTurn` sets
    // on every inbound chat turn. Guessing a connection when the field is
    // missing would pick an arbitrary one for an agent with several.
    //
    // Pinning the DEGRADATION so it stays intentional: the handle drops, the
    // framing does not. If a future caller builds a context without the field,
    // the agent still knows it is a participant.
    const provider = new ChatIdentityInstructionProvider(
      {
        getConnection: async () => {
          throw new Error("must not be called without a connection id");
        },
      } as never,
      "slack"
    );

    const result = await provider.getInstructions(
      ctx({ organizationId: "acme", connectionId: undefined })
    );

    expect(result).toContain("participant in this conversation");
    expect(result).not.toContain("@");
  });

  test("orgless declared context emits generic framing without reading connections", async () => {
    let getCalled = false;
    const provider = new ChatIdentityInstructionProvider(
      managerReturning(
        { metadata: { botUsername: "foreign-bot", botUserId: "UFOREIGN" } },
        () => {
          getCalled = true;
        }
      ),
      "telegram"
    );

    const result = await provider.getInstructions(
      ctx({ organizationId: undefined, connectionId: undefined })
    );

    expect(result).toContain("participant in this conversation");
    expect(result).not.toContain("foreign-bot");
    expect(getCalled).toBe(false);
  });

  test("reads the connection inside the token org", async () => {
    let seenOrg: string | undefined;
    const provider = new ChatIdentityInstructionProvider(
      managerReturning({ metadata: { botUsername: "acme-bot" } }, () => {
        seenOrg = orgContext.getStore()?.organizationId;
      }),
      "telegram"
    );

    await provider.getInstructions(ctx({ organizationId: "acme-org" }));

    expect(seenOrg).toBe("acme-org");
  });

  test("no bot handle configured: still emits participant framing", async () => {
    const provider = new ChatIdentityInstructionProvider(
      managerReturning({ metadata: {} }),
      "whatsapp"
    );

    const result = await provider.getInstructions(
      ctx({ organizationId: "acme" })
    );

    expect(result).toContain("participant in this conversation");
    expect(result).toContain("WhatsApp");
  });

  test("no connection resolved at all: still emits participant framing", async () => {
    const provider = new ChatIdentityInstructionProvider(
      managerReturning(null),
      "gchat"
    );

    const result = await provider.getInstructions(
      ctx({ organizationId: "acme" })
    );

    expect(result).toContain("participant in this conversation");
  });

  test("connection lookup failure still emits participant framing", async () => {
    const provider = new ChatIdentityInstructionProvider(
      {
        getConnection: async () => {
          throw new Error("store unavailable");
        },
      } as never,
      "telegram"
    );

    const result = await provider.getInstructions(
      ctx({ organizationId: "acme" })
    );

    expect(result).toContain("participant in this conversation");
  });

  test.each([
    ["telegram", "Telegram"],
    ["slack", "Slack"],
    ["discord", "Discord"],
    ["whatsapp", "WhatsApp"],
    ["teams", "Microsoft Teams"],
    ["gchat", "Google Chat"],
  ])(
    "%s renders a human platform label, never the raw key",
    async (platform, label) => {
      const provider = new ChatIdentityInstructionProvider(
        managerReturning({ metadata: { botUsername: "bot" } }),
        platform
      );

      const result = await provider.getInstructions(
        ctx({ organizationId: "acme" })
      );

      expect(result).toContain(label);
      expect(result).toContain("participant in this conversation");
    }
  );

  test("output stays identical across conversations on one connection", async () => {
    const provider = new ChatIdentityInstructionProvider(
      managerReturning({
        metadata: {
          botUsername: "burembalobubot",
          botUserId: "8834276769",
        },
      }),
      "telegram"
    );

    const first = await provider.getInstructions(
      ctx({ organizationId: "buremba", userId: "user-a", sessionKey: "chat-1" })
    );
    const second = await provider.getInstructions(
      ctx({ organizationId: "buremba", userId: "user-b", sessionKey: "chat-2" })
    );

    expect(first).toBe(second);
    expect(first).not.toContain("user-a");
    expect(first).not.toContain("chat-1");
  });
});

describe("every chat platform is wired to an instruction provider", () => {
  function adapterFor(platform: string) {
    const manager = Object.create(
      ChatInstanceManager.prototype
    ) as ChatInstanceManager;
    return (
      manager as unknown as {
        createPlatformAdapter: (name: string) => {
          getInstructionProvider?: () => unknown;
        };
      }
    ).createPlatformAdapter(platform);
  }

  test("telegram gets the generic provider", () => {
    const provider = adapterFor("telegram").getInstructionProvider?.();

    expect(provider).toBeInstanceOf(ChatIdentityInstructionProvider);
    expect(provider).not.toBeInstanceOf(SlackInstructionProvider);
  });

  test("slack — a platform declaring its own provider keeps it", () => {
    const provider = adapterFor("slack").getInstructionProvider?.();

    expect(provider).toBeInstanceOf(SlackInstructionProvider);
  });

  test("every registered platform resolves a provider", () => {
    const platforms = Object.keys(PLATFORM_REGISTRY);
    expect(platforms.length).toBeGreaterThan(0);

    const missing = platforms.filter(
      (p) =>
        !(
          adapterFor(p).getInstructionProvider?.() instanceof
          ChatIdentityInstructionProvider
        )
    );

    expect(missing).toEqual([]);
  });
});

describe("SlackInstructionProvider still adds its own quirks", () => {
  test("keeps mention guidance on top of the shared framing", async () => {
    const provider = new SlackInstructionProvider(
      managerReturning({
        metadata: { botUsername: "acme-bot", botUserId: "UACME" },
      })
    );

    const result = await provider.getInstructions(
      ctx({ organizationId: "acme-org" })
    );

    expect(result).toContain("<@UACME>");
    expect(result).toContain("participant in this conversation");
    expect(result).toContain("@acme-bot");
  });
});

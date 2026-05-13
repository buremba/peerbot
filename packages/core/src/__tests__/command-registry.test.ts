/**
 * Tests for command-registry.ts.
 *
 * No prior tests existed for CommandRegistry. This file covers:
 * register, get, getAll, tryHandle (success, not-found, handler-throws).
 */

import { describe, expect, mock, test } from "bun:test";
import {
  CommandRegistry,
  type CommandContext,
  type CommandDefinition,
} from "../command-registry";

// ── Minimal context factory ───────────────────────────────────────────────────

function makeCtx(overrides?: Partial<CommandContext>): CommandContext {
  return {
    userId: "user-1",
    channelId: "C1",
    args: "",
    platform: "slack",
    reply: mock(async () => {}),
    ...overrides,
  };
}

// ── register / get / getAll ──────────────────────────────────────────────────

describe("CommandRegistry.register / get / getAll", () => {
  test("registered command is retrievable by name", () => {
    const registry = new CommandRegistry();
    const cmd: CommandDefinition = {
      name: "help",
      description: "Show help",
      handler: async () => {},
    };
    registry.register(cmd);
    expect(registry.get("help")).toBe(cmd);
  });

  test("get returns undefined for unknown command", () => {
    const registry = new CommandRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  test("getAll returns all registered commands", () => {
    const registry = new CommandRegistry();
    const a: CommandDefinition = {
      name: "a",
      description: "A",
      handler: async () => {},
    };
    const b: CommandDefinition = {
      name: "b",
      description: "B",
      handler: async () => {},
    };
    registry.register(a);
    registry.register(b);
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  test("getAll returns empty array when no commands registered", () => {
    const registry = new CommandRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  test("re-registering same name overwrites the previous command", () => {
    const registry = new CommandRegistry();
    const first: CommandDefinition = {
      name: "ping",
      description: "v1",
      handler: async () => {},
    };
    const second: CommandDefinition = {
      name: "ping",
      description: "v2",
      handler: async () => {},
    };
    registry.register(first);
    registry.register(second);
    expect(registry.get("ping")?.description).toBe("v2");
    expect(registry.getAll()).toHaveLength(1);
  });
});

// ── tryHandle ────────────────────────────────────────────────────────────────

describe("CommandRegistry.tryHandle", () => {
  test("returns false for unregistered command", async () => {
    const registry = new CommandRegistry();
    const ctx = makeCtx();
    const handled = await registry.tryHandle("nonexistent", ctx);
    expect(handled).toBe(false);
  });

  test("returns true and calls handler for registered command", async () => {
    const registry = new CommandRegistry();
    const handlerFn = mock(async () => {});
    registry.register({
      name: "ping",
      description: "Ping",
      handler: handlerFn,
    });

    const ctx = makeCtx({ args: "hello" });
    const handled = await registry.tryHandle("ping", ctx);

    expect(handled).toBe(true);
    expect(handlerFn).toHaveBeenCalledTimes(1);
    expect(handlerFn).toHaveBeenCalledWith(ctx);
  });

  test("handler receives the correct context", async () => {
    const registry = new CommandRegistry();
    let receivedCtx: CommandContext | null = null;
    registry.register({
      name: "inspect",
      description: "Inspect context",
      handler: async (ctx) => {
        receivedCtx = ctx;
      },
    });

    const ctx = makeCtx({ userId: "u-42", channelId: "C99", args: "foo bar" });
    await registry.tryHandle("inspect", ctx);

    expect(receivedCtx?.userId).toBe("u-42");
    expect(receivedCtx?.channelId).toBe("C99");
    expect(receivedCtx?.args).toBe("foo bar");
  });

  test("handler error: still returns true and sends error reply", async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: "boom",
      description: "Throws",
      handler: async () => {
        throw new Error("handler exploded");
      },
    });

    const replyFn = mock(async () => {});
    const ctx = makeCtx({ reply: replyFn });
    const handled = await registry.tryHandle("boom", ctx);

    expect(handled).toBe(true);
    // reply should have been called once with an error message
    expect(replyFn).toHaveBeenCalledTimes(1);
    const [replyArg] = (replyFn as any).mock.calls[0] as [string];
    expect(typeof replyArg).toBe("string");
    expect(replyArg.toLowerCase()).toMatch(/wrong|error|try again/i);
  });

  test("reply is NOT called when handler succeeds", async () => {
    const registry = new CommandRegistry();
    const replyFn = mock(async () => {});
    registry.register({
      name: "ok",
      description: "OK",
      handler: async (ctx) => {
        // handler calls reply itself, not the registry
        await ctx.reply("custom response");
      },
    });

    const ctx = makeCtx({ reply: replyFn });
    await registry.tryHandle("ok", ctx);

    // reply called exactly once — from the handler's explicit call, not the error path
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect((replyFn as any).mock.calls[0][0]).toBe("custom response");
  });

  test("independent registries do not share commands", async () => {
    const r1 = new CommandRegistry();
    const r2 = new CommandRegistry();
    r1.register({
      name: "shared",
      description: "In r1",
      handler: async () => {},
    });

    expect(r1.get("shared")).toBeDefined();
    expect(r2.get("shared")).toBeUndefined();
    expect(await r2.tryHandle("shared", makeCtx())).toBe(false);
  });
});

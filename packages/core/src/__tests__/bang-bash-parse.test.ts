import { describe, expect, test } from "bun:test";
import { parseBangBashCommand } from "../worker/wire";

describe("parseBangBashCommand", () => {
  test("`!cmd` → run with output kept in model context", () => {
    expect(parseBangBashCommand("!ls /workspace")).toEqual({
      command: "ls /workspace",
      excludeFromContext: false,
    });
  });

  test("`!!cmd` → run with output EXCLUDED from model context", () => {
    expect(parseBangBashCommand("!!cat secret.txt")).toEqual({
      command: "cat secret.txt",
      excludeFromContext: true,
    });
  });

  test("a leading space after the bang is allowed and trimmed", () => {
    expect(parseBangBashCommand("! ls")).toEqual({
      command: "ls",
      excludeFromContext: false,
    });
    expect(parseBangBashCommand("!!  echo hi")).toEqual({
      command: "echo hi",
      excludeFromContext: true,
    });
  });

  test("a triple `!!!…` is `!!` + a command that itself begins with `!`", () => {
    expect(parseBangBashCommand("!!!x")).toEqual({
      command: "!x",
      excludeFromContext: true,
    });
  });

  test("a bare `!` or `!!` (no command) is NOT a bash action → null", () => {
    expect(parseBangBashCommand("!")).toBeNull();
    expect(parseBangBashCommand("!!")).toBeNull();
    expect(parseBangBashCommand("!  ")).toBeNull();
    expect(parseBangBashCommand("!!   ")).toBeNull();
  });

  test("ordinary text (no leading bang) → null", () => {
    expect(parseBangBashCommand("ls /workspace")).toBeNull();
    expect(parseBangBashCommand("what is 2+2?")).toBeNull();
    expect(parseBangBashCommand("")).toBeNull();
    // A bang not at the start is ordinary text.
    expect(parseBangBashCommand("run this: !ls")).toBeNull();
  });
});

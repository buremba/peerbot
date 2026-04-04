import { describe, expect, test } from "bun:test";
import { isSenderAllowed } from "../connections/message-handler-bridge";

describe("isSenderAllowed", () => {
  test("allows everyone when allowFrom is not configured", () => {
    expect(isSenderAllowed(undefined, "user-1")).toBe(true);
  });

  test("blocks everyone when allowFrom is an empty array", () => {
    expect(isSenderAllowed([], "user-1")).toBe(false);
  });

  test("only allows listed users when allowFrom is configured", () => {
    expect(isSenderAllowed(["user-1"], "user-1")).toBe(true);
    expect(isSenderAllowed(["user-1"], "user-2")).toBe(false);
  });
});

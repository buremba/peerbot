import { afterEach, describe, expect, test } from "bun:test";
import { parseKeyValueEntries, resolveSecretFlag } from "../secret-value.js";

const ENV_KEYS = ["LOBU_TEST_SECRET", "LOBU_TEST_TOKEN"];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("resolveSecretFlag", () => {
  test("passes a literal value through", () => {
    expect(resolveSecretFlag("sk-live-123", "--key")).toBe("sk-live-123");
  });

  test("resolves a $VAR reference from the environment", () => {
    process.env.LOBU_TEST_SECRET = "resolved-value";
    expect(resolveSecretFlag("$LOBU_TEST_SECRET", "--key")).toBe(
      "resolved-value"
    );
  });

  test("trims whitespace on both literal and resolved values", () => {
    process.env.LOBU_TEST_SECRET = "  padded  ";
    expect(resolveSecretFlag("$LOBU_TEST_SECRET", "--key")).toBe("padded");
    expect(resolveSecretFlag("  literal  ", "--key")).toBe("literal");
  });

  test("throws when the referenced env var is unset", () => {
    expect(() => resolveSecretFlag("$LOBU_TEST_SECRET", "--key")).toThrow(
      "$LOBU_TEST_SECRET"
    );
  });

  test("throws on an empty value and a bare $", () => {
    expect(() => resolveSecretFlag("", "--key")).toThrow("--key");
    expect(() => resolveSecretFlag("$", "--key")).toThrow("--key");
  });
});

describe("parseKeyValueEntries", () => {
  test("parses key=value entries into a record", () => {
    expect(
      parseKeyValueEntries(["token=abc", "teamId=team_1"], "--credential")
    ).toEqual({ token: "abc", teamId: "team_1" });
  });

  test("resolves $VAR values from the environment", () => {
    process.env.LOBU_TEST_TOKEN = "tok-999";
    expect(
      parseKeyValueEntries(["token=$LOBU_TEST_TOKEN"], "--credential")
    ).toEqual({ token: "tok-999" });
  });

  test("keeps = characters inside the value", () => {
    expect(parseKeyValueEntries(["query=a=b"], "--credential")).toEqual({
      query: "a=b",
    });
  });

  test("rejects entries without a key or =", () => {
    expect(() => parseKeyValueEntries(["no-equals"], "--credential")).toThrow(
      "key=value"
    );
    expect(() => parseKeyValueEntries(["=value"], "--credential")).toThrow(
      "key=value"
    );
  });

  test("never echoes entry content in errors — not even the key part", () => {
    // A pasted secret can land on either side of the `=`, or after a `$`.
    for (const entry of [
      "sk-live-oops",
      "sk-live-oops=",
      "=sk-live-oops",
      "token=$sk-live-oops",
    ]) {
      let message = "";
      try {
        parseKeyValueEntries([entry], "--credential");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("sk-live-oops");
      expect(message).toContain("entry #1");
    }
  });

  test("unset $VAR errors name the variable only for valid identifiers", () => {
    // A real env-var NAME is an identifier the user typed as a reference —
    // naming it is safe and useful.
    expect(() =>
      parseKeyValueEntries(["token=$LOBU_TEST_UNSET_VAR"], "--credential")
    ).toThrow("$LOBU_TEST_UNSET_VAR");
  });
});

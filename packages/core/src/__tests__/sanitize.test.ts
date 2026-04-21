import { describe, expect, test } from "bun:test";
import {
  sanitizeConversationId,
  sanitizeFilename,
  sanitizeForLogging,
  stripEnv,
} from "../utils/sanitize";

describe("sanitizeFilename", () => {
  test("removes path traversal (strips to basename)", () => {
    // The regex strips everything up to and including the last / or \
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  });

  test("removes windows path traversal (strips to basename)", () => {
    expect(sanitizeFilename("..\\..\\windows\\system32")).toBe("system32");
  });

  test("removes special characters", () => {
    expect(sanitizeFilename('file<>|*?:"name.txt')).toBe("file_______name.txt");
  });

  test("removes leading dots (hidden files)", () => {
    expect(sanitizeFilename(".hidden")).toBe("hidden");
    expect(sanitizeFilename("...secret")).toBe("secret");
  });

  test("collapses consecutive dots", () => {
    expect(sanitizeFilename("file..name..txt")).toBe("file.name.txt");
  });

  test("returns unnamed_file for empty result", () => {
    expect(sanitizeFilename("")).toBe("unnamed_file");
    expect(sanitizeFilename("...")).toBe("unnamed_file");
    expect(sanitizeFilename("///")).toBe("unnamed_file");
  });

  test("preserves safe filenames", () => {
    expect(sanitizeFilename("document.pdf")).toBe("document.pdf");
    expect(sanitizeFilename("my-file_v2.tar.gz")).toBe("my-file_v2.tar.gz");
  });

  test("truncates to maxLength", () => {
    const long = "a".repeat(300);
    expect(sanitizeFilename(long).length).toBe(255);
    expect(sanitizeFilename(long, 10).length).toBe(10);
  });

  test("preserves spaces", () => {
    expect(sanitizeFilename("my file name.txt")).toBe("my file name.txt");
  });

  test("strips directory path components", () => {
    expect(sanitizeFilename("/path/to/file.txt")).toBe("file.txt");
    expect(sanitizeFilename("C:\\Users\\doc.pdf")).toBe("doc.pdf");
  });
});

describe("sanitizeConversationId", () => {
  test("preserves valid conversation IDs", () => {
    expect(sanitizeConversationId("1756766056.836119")).toBe(
      "1756766056.836119"
    );
  });

  test("replaces slashes and special chars", () => {
    // Only non-alphanumeric (except . and -) are replaced
    expect(sanitizeConversationId("thread/123/../456")).toBe(
      "thread_123_.._456"
    );
  });

  test("preserves hyphens and dots", () => {
    expect(sanitizeConversationId("abc-def.123")).toBe("abc-def.123");
  });

  test("replaces colons and spaces", () => {
    expect(sanitizeConversationId("a:b c")).toBe("a_b_c");
  });
});

describe("sanitizeForLogging", () => {
  test("redacts default sensitive keys (lowercase match)", () => {
    const obj = {
      // "token" is in the sensitive list and matches case-insensitively
      token: "bearer-xyz",
      // "password" matches
      password: "secret123",
      timeout: 5000,
    };
    const result = sanitizeForLogging(obj);
    expect(result.token).toBe("[REDACTED:10]");
    expect(result.password).toBe("[REDACTED:9]");
    expect(result.timeout).toBe(5000);
  });

  test("matches via includes (key containing sensitive substring)", () => {
    // Object key "my_api_key_field" lowercased includes "api_key"
    const obj = { my_api_key_field: "secret-value" };
    const result = sanitizeForLogging(obj);
    expect(result.my_api_key_field).toBe("[REDACTED:12]");
  });

  test("redacts authorization header (case-insensitive key)", () => {
    // "Authorization" lowered → "authorization" which includes "authorization"
    const obj = { Authorization: "Bearer tok12" };
    const result = sanitizeForLogging(obj);
    expect(result.Authorization).toBe("[REDACTED:12]");
  });

  test("recursively sanitizes nested objects", () => {
    const obj = {
      config: { password: "secret", port: 3000 },
    };
    const result = sanitizeForLogging(obj);
    expect(result.config.password).toBe("[REDACTED:6]");
    expect(result.config.port).toBe(3000);
  });

  test("recursively sanitizes env key", () => {
    const obj = { env: { TOKEN: "abc123" } };
    const result = sanitizeForLogging(obj);
    expect(result.env.TOKEN).toBe("[REDACTED:6]");
  });

  test("handles arrays (recurses into elements)", () => {
    const arr = [{ token: "secret" }, { name: "safe" }];
    const result = sanitizeForLogging(arr);
    expect(result[0].token).toBe("[REDACTED:6]");
    expect(result[1].name).toBe("safe");
  });

  test("handles additional sensitive keys", () => {
    const obj = { customSecret: "hidden", name: "visible" };
    const result = sanitizeForLogging(obj, ["customsecret"]);
    expect(result.customSecret).toBe("[REDACTED:6]");
    expect(result.name).toBe("visible");
  });

  test("returns primitives unchanged", () => {
    expect(sanitizeForLogging("string")).toBe("string");
    expect(sanitizeForLogging(42)).toBe(42);
    expect(sanitizeForLogging(null)).toBe(null);
    expect(sanitizeForLogging(undefined)).toBe(undefined);
  });

  test("does not mutate original object", () => {
    const obj = { apiKey: "secret" };
    sanitizeForLogging(obj);
    expect(obj.apiKey).toBe("secret");
  });

  test("only redacts string values of sensitive keys", () => {
    const obj = { token: 12345 };
    const result = sanitizeForLogging(obj);
    // Non-string sensitive values are not redacted
    expect(result.token).toBe(12345);
  });
});

describe("stripEnv", () => {
  test("removes listed keys and drops undefined values", () => {
    const env = stripEnv(
      {
        PATH: "/usr/bin",
        WORKER_TOKEN: "secret",
        DISPATCHER_URL: "http://gateway:8080",
        HOME: "/workspace",
        EMPTY: undefined,
      },
      ["WORKER_TOKEN", "DISPATCHER_URL"]
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/workspace",
    });
  });

  test("returns empty object when all values are stripped or undefined", () => {
    expect(stripEnv({ A: undefined, B: "hidden" }, ["B"])).toEqual({});
  });

  test("matches keys exactly (case-sensitive)", () => {
    const env = stripEnv({ Token: "keep", TOKEN: "strip" }, ["TOKEN"]);
    expect(env).toEqual({ Token: "keep" });
  });
});

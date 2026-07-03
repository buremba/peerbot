import { describe, expect, test } from "bun:test";
import {
  isSdkCompat,
  resolveSdkCompat,
  SDK_COMPAT_PROTOCOLS,
} from "../sdk-compat";

describe("sdk-compat registry", () => {
  test("openai maps to the openai-completions adapter", () => {
    const p = resolveSdkCompat("openai");
    expect(p?.api).toBe("openai-completions");
    expect(p?.registryAlias).toBe("openai");
    // OpenAI-compatible keys ride as Bearer (no explicit header).
    expect(p?.apiKeyHeader).toBeUndefined();
  });

  test("anthropic maps to anthropic-messages with x-api-key", () => {
    const p = resolveSdkCompat("anthropic");
    expect(p?.api).toBe("anthropic-messages");
    expect(p?.registryAlias).toBe("anthropic");
    // Anthropic 401s on Bearer — the key must ride in x-api-key.
    expect(p?.apiKeyHeader).toBe("x-api-key");
  });

  test("isSdkCompat gates routable protocols", () => {
    expect(isSdkCompat("openai")).toBe(true);
    expect(isSdkCompat("anthropic")).toBe(true);
    expect(isSdkCompat("google")).toBe(true);
    // Not routable:
    expect(isSdkCompat(null)).toBe(false);
    expect(isSdkCompat(undefined)).toBe(false);
    expect(isSdkCompat("made-up")).toBe(false);
  });

  test("resolveSdkCompat returns null for unroutable input", () => {
    expect(resolveSdkCompat(null)).toBeNull();
    expect(resolveSdkCompat("nope")).toBeNull();
  });

  test("every protocol declares api, registryAlias, and label", () => {
    for (const [key, p] of Object.entries(SDK_COMPAT_PROTOCOLS)) {
      expect(p.api, `${key}.api`).toBeTruthy();
      expect(p.registryAlias, `${key}.registryAlias`).toBeTruthy();
      expect(p.label, `${key}.label`).toBeTruthy();
    }
  });
});

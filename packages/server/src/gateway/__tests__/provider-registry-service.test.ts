import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderRegistryService,
  resolveProviderRegistryFromRaw,
  resolveProviderRegistryPath,
} from "../services/provider-registry-service.js";

const testConfig = {
  providers: [
    {
      id: "groq",
      name: "Groq",
      description: "Fast inference",
      providers: [
        {
          displayName: "Groq",
          iconUrl: "https://example.com/groq.png",
          envVarName: "GROQ_API_KEY",
          upstreamBaseUrl: "https://api.groq.com/openai",
          apiKeyInstructions: "Get key",
          apiKeyPlaceholder: "gsk_...",
          defaultModel: "llama-3.3-70b-versatile",
        },
      ],
    },
  ],
};

let fetchCallCount = 0;
const originalFetch = globalThis.fetch;

function setupMockFetch(config: unknown, statusCode = 200) {
  fetchCallCount = 0;
  globalThis.fetch = async () => {
    fetchCallCount++;
    return new Response(JSON.stringify(config), {
      status: statusCode,
      headers: { "Content-Type": "application/json" },
    });
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchCallCount = 0;
});

describe("ProviderRegistryService", () => {
  test("loads provider configs from HTTP URL", async () => {
    setupMockFetch(testConfig);
    const service = new ProviderRegistryService(
      "https://example.com/providers.json"
    );

    const providers = await service.getProviderConfigs();

    expect(Object.keys(providers)).toEqual(["groq"]);
    expect(providers.groq.displayName).toBe("Groq");
    expect(providers.groq.defaultModel).toBe("llama-3.3-70b-versatile");
  });

  test("returns empty map when fetch fails", async () => {
    setupMockFetch({ error: "not found" }, 500);
    const service = new ProviderRegistryService(
      "https://example.com/providers.json"
    );
    expect(await service.getProviderConfigs()).toEqual({});
  });

  test("returns empty map when configUrl is omitted", async () => {
    const service = new ProviderRegistryService();
    expect(await service.getProviderConfigs()).toEqual({});
  });

  test("caches provider registry", async () => {
    setupMockFetch(testConfig);
    const service = new ProviderRegistryService(
      "https://example.com/providers.json"
    );

    await service.getProviderConfigs();
    await service.getProviderConfigs();

    expect(fetchCallCount).toBe(1);
  });

  test("getRawProviderEntries preserves env placeholders", async () => {
    const envKey = `__TEST_PROVIDER_KEY_${Date.now()}`;
    process.env[envKey] = "secret123";
    try {
      setupMockFetch({
        providers: [
          {
            id: "test",
            name: "Test",
            providers: [
              {
                displayName: "Test",
                iconUrl: "",
                envVarName: envKey,
                upstreamBaseUrl: `https://api.example.com/\${env:${envKey}}`,
                apiKeyInstructions: "",
                apiKeyPlaceholder: "",
              },
            ],
          },
        ],
      });
      const service = new ProviderRegistryService(
        "https://example.com/providers.json"
      );
      const raw = await service.getRawProviderEntries();
      expect(raw[0]?.providers[0]?.upstreamBaseUrl).toBe(
        `https://api.example.com/\${env:${envKey}}`
      );
      const substituted = await service.getProviderConfigs();
      expect(substituted.test.upstreamBaseUrl).toBe(
        "https://api.example.com/secret123"
      );
    } finally {
      delete process.env[envKey];
    }
  });

  test("resolveProviderRegistryFromRaw rejects malformed payloads", () => {
    expect(resolveProviderRegistryFromRaw("{}")).toBeNull();
  });
});

describe("resolveProviderRegistryPath", () => {
  const savedEnv = process.env.LOBU_PROVIDER_REGISTRY_PATH;
  const savedCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
    else process.env.LOBU_PROVIDER_REGISTRY_PATH = savedEnv;
    process.chdir(savedCwd);
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  test("LOBU_PROVIDER_REGISTRY_PATH always wins (incl. http URLs)", () => {
    process.env.LOBU_PROVIDER_REGISTRY_PATH = "https://example.com/p.json";
    expect(resolveProviderRegistryPath()).toBe("https://example.com/p.json");
  });

  test("falls back to <cwd>/config/providers.json when present", () => {
    delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lobu-cwd-prov-")));
    tempDirs.push(dir);
    const cfgDir = join(dir, "config");
    require("node:fs").mkdirSync(cfgDir);
    writeFileSync(join(cfgDir, "providers.json"), '{"providers":[]}');
    process.chdir(dir);
    expect(resolveProviderRegistryPath()).toBe(
      join(dir, "config/providers.json")
    );
  });

  test("returns a path that exists, or undefined — never a bogus cwd path", () => {
    delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
    const dir = mkdtempSync(join(tmpdir(), "lobu-empty-prov-"));
    tempDirs.push(dir);
    process.chdir(dir);
    const resolved = resolveProviderRegistryPath();
    if (resolved !== undefined) {
      // bundle-relative providers.json (only present in built dist) — must exist
      expect(existsSync(resolved)).toBe(true);
    }
  });
});

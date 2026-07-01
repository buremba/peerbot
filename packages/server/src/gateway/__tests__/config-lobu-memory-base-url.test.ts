import { afterEach, describe, expect, test } from "bun:test";
import {
  buildGatewayConfig,
  getLobuMemoryUpstreamOrigin,
  resolveEmbeddedPublicGatewayUrl,
  resolveEmbeddedPublicWebOrigin,
} from "../config/index.js";
import { McpConfigService } from "../auth/mcp/config-service.js";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  DISPATCHER_URL: process.env.DISPATCHER_URL,
  PORT: process.env.PORT,
  PUBLIC_WEB_URL: process.env.PUBLIC_WEB_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("getLobuMemoryUpstreamOrigin", () => {
  test("derives loopback origin from PORT", () => {
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";
    process.env.PUBLIC_WEB_URL = "https://public.example.com";

    expect(getLobuMemoryUpstreamOrigin()).toBe("http://127.0.0.1:8787");
  });

  test("derives origin from DISPATCHER_URL when set", () => {
    process.env.DISPATCHER_URL = "http://gateway.internal:9000/lobu";

    expect(getLobuMemoryUpstreamOrigin()).toBe("http://gateway.internal:9000");
  });
});

describe("resolveEmbeddedPublicGatewayUrl", () => {
  test("maps PUBLIC_WEB_URL to the /lobu gateway mount", () => {
    process.env.PUBLIC_WEB_URL = "https://public.example.com";
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";

    expect(resolveEmbeddedPublicWebOrigin()).toBe("https://public.example.com");
    expect(resolveEmbeddedPublicGatewayUrl()).toBe(
      "https://public.example.com/lobu"
    );
  });
});

describe("McpConfigService lobu-memory upstream", () => {
  test("derives upstream from internal gateway URL, not PUBLIC_WEB_URL", async () => {
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";
    process.env.PUBLIC_WEB_URL = "https://public.example.com";

    const service = new McpConfigService({
      lobuMemory: {
        resolveOrgSlug: async () => "acme",
      },
    });

    await expect(service.getHttpServer("lobu-memory", "agent1")).resolves.toEqual({
      id: "lobu-memory",
      upstreamUrl: "http://127.0.0.1:8787/mcp/acme",
      internal: true,
    });
  });
});

describe("buildGatewayConfig embedded overrides", () => {
  test("does not store lobuMemory config — upstream is derived at runtime", () => {
    process.env.DATABASE_URL = "postgres://localhost/lobu";
    process.env.PUBLIC_WEB_URL = "https://public.example.com";
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";

    const config = buildGatewayConfig({
      mcp: { publicGatewayUrl: resolveEmbeddedPublicGatewayUrl() },
      auth: { issuerUrl: resolveEmbeddedPublicWebOrigin() },
    });

    expect("lobuMemory" in config).toBe(false);
    expect(config.mcp.publicGatewayUrl).toBe("https://public.example.com/lobu");
  });
});
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { McpOAuthConfig, SecretPutOptions, SecretRef } from "@lobu/core";
import {
  getStoredCredential,
  startDeviceAuth,
  tryCompletePendingDeviceAuth,
} from "../routes/internal/device-auth.js";
import type { SecretListEntry, WritableSecretStore } from "../secrets/index.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface HttpServerConfig {
  upstreamUrl: string;
  oauth?: McpOAuthConfig;
}

class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<
    string,
    { value: string; updatedAt: number }
  >();

  constructor(private readonly scheme: string = "host") {}

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith(`${this.scheme}://`)) {
      return null;
    }

    const name = decodeURIComponent(ref.slice(`${this.scheme}://`.length));
    return this.entries.get(name)?.value ?? null;
  }

  async put(
    name: string,
    value: string,
    _options?: SecretPutOptions
  ): Promise<SecretRef> {
    this.entries.set(name, { value, updatedAt: Date.now() });
    return `${this.scheme}://${encodeURIComponent(name)}` as SecretRef;
  }

  async delete(nameOrRef: string): Promise<void> {
    const name = nameOrRef.startsWith(`${this.scheme}://`)
      ? decodeURIComponent(nameOrRef.slice(`${this.scheme}://`.length))
      : nameOrRef;
    this.entries.delete(name);
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    const entries: SecretListEntry[] = [];
    for (const [name, entry] of this.entries) {
      if (prefix && !name.startsWith(prefix)) {
        continue;
      }

      entries.push({
        ref: `${this.scheme}://${encodeURIComponent(name)}` as SecretRef,
        backend: this.scheme,
        name,
        updatedAt: entry.updatedAt,
      });
    }
    return entries;
  }
}

let originalEncryptionKey: string | undefined;
let originalFetch: typeof fetch;

beforeAll(() => {
  originalEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  if (originalEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
  globalThis.fetch = originalFetch;
});

describe("device auth secret storage", () => {
  let secretStore: InMemoryWritableStore;

  beforeEach(() => {
    // Override scheme so the host store accepts the default `secret://` refs
    // produced by the helpers in device-auth.ts.
    secretStore = new InMemoryWritableStore("secret");

    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;

      if (url.endsWith("/oauth/register")) {
        return new Response(
          JSON.stringify({
            client_id: "client-123",
            client_secret: "client-secret-xyz",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (url.endsWith("/oauth/device_authorization")) {
        return new Response(
          JSON.stringify({
            device_code: "device-code-abc",
            user_code: "user-code-123",
            verification_uri: "https://issuer.example.com/activate",
            verification_uri_complete:
              "https://issuer.example.com/activate?user_code=user-code-123",
            expires_in: 600,
            interval: 5,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (url.endsWith("/oauth/token")) {
        const body = init?.body?.toString() ?? "";
        if (
          body.includes(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
          )
        ) {
          return new Response(
            JSON.stringify({
              access_token: "access-token-123",
              refresh_token: "refresh-token-456",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };
  });

  test("device-auth state and credentials persist directly in the secret store", async () => {
    const configService = {
      getHttpServer: async () =>
        ({
          upstreamUrl: "https://issuer.example.com/mcp",
        }) satisfies HttpServerConfig,
    };

    const started = await startDeviceAuth(
      secretStore,
      configService,
      "github",
      "agent-1",
      "user-1"
    );

    expect(started?.userCode).toBe("user-code-123");

    // Pending device-auth state is now stored directly under the secret name
    // (no Redis pointer). The blob still encrypts via PostgresSecretStore in
    // production; the in-memory test store keeps the JSON plaintext.
    const pendingEntries = await secretStore.list(
      "mcp-auth/agent-1/user-1/github/device-auth"
    );
    expect(pendingEntries).toHaveLength(1);

    const accessToken = await tryCompletePendingDeviceAuth(
      secretStore,
      "agent-1",
      "user-1",
      "github"
    );

    expect(accessToken).toBe("access-token-123");

    // Pending state cleaned up after completion.
    expect(
      await secretStore.list("mcp-auth/agent-1/user-1/github/device-auth")
    ).toHaveLength(0);

    const credential = await getStoredCredential(
      secretStore,
      "agent-1",
      "user-1",
      "github"
    );
    expect(credential?.accessToken).toBe("access-token-123");
    expect(credential?.refreshToken).toBe("refresh-token-456");

    // Sanity: the only entries left are the issued credential and the cached
    // dynamic-client registration.
    const allEntries = await secretStore.list();
    const names = allEntries.map((e) => e.name).sort();
    expect(names).toEqual([
      "mcp-auth/agent-1/user-1/github/credential",
      "mcp-auth/clients/github/registration",
    ]);
  });
});

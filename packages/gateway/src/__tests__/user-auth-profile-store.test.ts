import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import { RedisSecretStore } from "../secrets";
import { UserAuthProfileStore } from "../auth/settings/user-auth-profile-store";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let originalEncryptionKey: string | undefined;

beforeAll(() => {
  originalEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

afterAll(() => {
  if (originalEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
});

function createStore() {
  const redis = new MockRedisClient();
  const secretStore = new RedisSecretStore(redis as any, "lobu:test:secrets:");
  const store = new UserAuthProfileStore(redis as any, secretStore);
  return { store, redis, secretStore };
}

describe("UserAuthProfileStore", () => {
  let setup: ReturnType<typeof createStore>;

  beforeEach(() => {
    setup = createStore();
  });

  test("upsert stores profile under (userId, agentId) and replaces credential with ref", async () => {
    const { store, redis, secretStore } = setup;
    const stored = await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-secret",
      authType: "api-key",
      label: "openai",
      model: "*",
      createdAt: 0,
    });

    expect(stored.credential).toBeUndefined();
    expect(stored.credentialRef).toBeDefined();
    expect(await secretStore.get(stored.credentialRef!)).toBe("sk-secret");

    const raw = await redis.get("user:auth-profiles:u1:agent-1");
    expect(raw).toBeDefined();
    expect(raw).not.toContain("sk-secret");

    const list = await store.list("u1", "agent-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("p1");
  });

  test("upsert persists refresh token through secret store", async () => {
    const { store, secretStore } = setup;
    const stored = await store.upsert("u1", "agent-1", {
      id: "oauth-1",
      provider: "claude",
      credential: "access-token",
      authType: "oauth",
      label: "claude",
      model: "*",
      createdAt: 0,
      metadata: {
        refreshToken: "refresh-token-123",
        expiresAt: 9_999_999_999,
      },
    });

    expect(stored.metadata?.refreshToken).toBeUndefined();
    expect(stored.metadata?.refreshTokenRef).toBeDefined();
    expect(await secretStore.get(stored.metadata!.refreshTokenRef!)).toBe(
      "refresh-token-123"
    );
  });

  test("upsert with same (provider, model) replaces existing entry", async () => {
    const { store } = setup;
    await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-1",
      authType: "api-key",
      label: "old",
      model: "*",
      createdAt: 0,
    });
    await store.upsert("u1", "agent-1", {
      id: "p2",
      provider: "openai",
      credential: "sk-2",
      authType: "api-key",
      label: "new",
      model: "*",
      createdAt: 0,
    });

    const list = await store.list("u1", "agent-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("p2");
  });

  test("isolates profiles per user", async () => {
    const { store } = setup;
    await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-u1",
      authType: "api-key",
      label: "u1",
      model: "*",
      createdAt: 0,
    });
    await store.upsert("u2", "agent-1", {
      id: "p2",
      provider: "openai",
      credential: "sk-u2",
      authType: "api-key",
      label: "u2",
      model: "*",
      createdAt: 0,
    });

    expect(await store.list("u1", "agent-1")).toHaveLength(1);
    expect(await store.list("u2", "agent-1")).toHaveLength(1);
    expect(await store.list("u3", "agent-1")).toEqual([]);
  });

  test("remove drops profile and its secrets", async () => {
    const { store, secretStore } = setup;
    const stored = await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-1",
      authType: "api-key",
      label: "u1",
      model: "*",
      createdAt: 0,
    });

    const result = await store.remove("u1", "agent-1", { provider: "openai" });
    expect(result.removed).toHaveLength(1);
    expect(result.secretsDeleted).toBeGreaterThan(0);
    expect(await store.list("u1", "agent-1")).toEqual([]);
    expect(await secretStore.get(stored.credentialRef!)).toBeNull();
  });

  test("dropAgent cascades through all secrets", async () => {
    const { store, redis, secretStore } = setup;
    const stored = await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-1",
      authType: "api-key",
      label: "u1",
      model: "*",
      createdAt: 0,
    });
    await store.dropAgent("u1", "agent-1");

    expect(await redis.get("user:auth-profiles:u1:agent-1")).toBeNull();
    expect(await secretStore.get(stored.credentialRef!)).toBeNull();
  });

  test("scanAllOAuth yields every (userId, agentId) pair", async () => {
    const { store } = setup;
    await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "claude",
      credential: "x",
      authType: "oauth",
      label: "x",
      model: "*",
      createdAt: 0,
    });
    await store.upsert("u2", "agent-2", {
      id: "p2",
      provider: "claude",
      credential: "y",
      authType: "oauth",
      label: "y",
      model: "*",
      createdAt: 0,
    });

    const refs: string[] = [];
    for await (const ref of store.scanAllOAuth()) {
      refs.push(`${ref.userId}:${ref.agentId}`);
    }
    expect(refs.sort()).toEqual(["u1:agent-1", "u2:agent-2"]);
  });
});

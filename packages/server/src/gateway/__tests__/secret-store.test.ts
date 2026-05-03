import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { SecretRef } from "@lobu/core";
import {
  deleteSecretsByPrefix,
  SecretStoreRegistry,
  type SecretListEntry,
  type SecretPutOptions,
  type SecretStore,
  type WritableSecretStore,
} from "../secrets/index.js";
import { orgContext } from "../../lobu/stores/org-context.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * In-memory writable secret store. Replaces the deleted RedisSecretStore in
 * tests — the production substrate is now PostgresSecretStore (covered by
 * its own test file).
 */
class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<
    string,
    { value: string; updatedAt: number; expiresAt?: number }
  >();

  constructor(
    private readonly scheme: string = "secret",
    private readonly backendLabel: string = "memory"
  ) {}

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith(`${this.scheme}://`)) return null;
    const name = decodeURIComponent(ref.slice(`${this.scheme}://`.length));
    const entry = this.entries.get(name);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.entries.delete(name);
      return null;
    }
    return entry.value;
  }

  async put(
    name: string,
    value: string,
    options?: SecretPutOptions
  ): Promise<SecretRef> {
    this.entries.set(name, {
      value,
      updatedAt: Date.now(),
      expiresAt: options?.ttlSeconds
        ? Date.now() + options.ttlSeconds * 1000
        : undefined,
    });
    return `${this.scheme}://${encodeURIComponent(name)}` as SecretRef;
  }

  async delete(nameOrRef: string): Promise<void> {
    let name = nameOrRef;
    if (nameOrRef.startsWith(`${this.scheme}://`)) {
      name = decodeURIComponent(nameOrRef.slice(`${this.scheme}://`.length));
    }
    this.entries.delete(name);
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    const results: SecretListEntry[] = [];
    for (const [name, entry] of this.entries) {
      if (prefix && !name.startsWith(prefix)) continue;
      results.push({
        ref: `${this.scheme}://${encodeURIComponent(name)}` as SecretRef,
        backend: this.backendLabel,
        name,
        updatedAt: entry.updatedAt,
      });
    }
    return results;
  }

  size(): number {
    return this.entries.size;
  }
}

class ReadOnlyAwsStub implements SecretStore {
  async get(_ref: SecretRef): Promise<string | null> {
    return null;
  }
}

describe("InMemoryWritableStore (test substrate parity check)", () => {
  let originalEncryptionKey: string | undefined;
  let store: InMemoryWritableStore;

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

  beforeEach(() => {
    store = new InMemoryWritableStore();
  });

  test("round-trips values", async () => {
    const ref = await store.put("agents/a/openai", "sk-test-secret");
    expect(ref).toBe("secret://agents%2Fa%2Fopenai");
    expect(await store.get(ref)).toBe("sk-test-secret");
  });

  test("lists refs by logical prefix", async () => {
    await store.put("system-env/OPENAI_API_KEY", "value-1");
    await store.put("agents/a/openai", "value-2");

    const entries = await store.list("system-env/");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("system-env/OPENAI_API_KEY");
  });
});

describe("deleteSecretsByPrefix", () => {
  let store: InMemoryWritableStore;

  beforeEach(() => {
    store = new InMemoryWritableStore();
  });

  test("deletes every secret whose name matches the prefix", async () => {
    await store.put("agents/a/auth-profiles/p1/credential", "c1");
    await store.put("agents/a/auth-profiles/p1/refresh-token", "r1");
    await store.put("agents/b/auth-profiles/p2/credential", "c2");

    const removed = await deleteSecretsByPrefix(store, "agents/a/");

    expect(removed).toBe(2);
    expect(await store.list("agents/a/")).toHaveLength(0);
    expect(await store.list("agents/b/")).toHaveLength(1);
  });
});

describe("SecretStoreRegistry caching", () => {
  let backing: InMemoryWritableStore;
  let registry: SecretStoreRegistry;

  beforeEach(() => {
    backing = new InMemoryWritableStore();
    registry = new SecretStoreRegistry(backing, { secret: backing });
  });

  test("serves repeated reads from cache without hitting the backing store", async () => {
    const ref = await registry.put("agents/a/key", "hello");

    // First read populates the cache.
    expect(await registry.get(ref)).toBe("hello");

    // Drop the underlying entry to prove the next read comes from cache.
    (backing as unknown as { entries: Map<string, unknown> }).entries.clear();
    expect(await registry.get(ref)).toBe("hello");
  });

  test("put invalidates the cached entry for the same ref", async () => {
    const ref = await registry.put("agents/a/key", "hello");
    expect(await registry.get(ref)).toBe("hello");

    await registry.put("agents/a/key", "world");
    expect(await registry.get(ref)).toBe("world");
  });

  test("delete invalidates the cached entry", async () => {
    const ref = await registry.put("agents/a/key", "hello");
    expect(await registry.get(ref)).toBe("hello");

    await registry.delete(ref);
    expect(await registry.get(ref)).toBeNull();
  });

  test("delete(name) invalidates cache entries keyed by ref", async () => {
    const name = "agents/a/key";
    const ref = await registry.put(name, "hello");

    expect(await registry.get(ref)).toBe("hello");
    expect(await registry.get(ref)).toBe("hello");

    await registry.delete(name);
    expect(await registry.get(ref)).toBeNull();
  });

  test("cache is keyed per org so two tenants reading the same ref don't share values", async () => {
    // Backing store that returns different values based on AsyncLocalStorage
    // org context — mirrors PostgresSecretStore's per-org resolution.
    class OrgAwareStore implements WritableSecretStore {
      readonly entries = new Map<string, string>(); // `${orgId}|${name}` → value
      async get(ref: SecretRef): Promise<string | null> {
        if (!ref.startsWith("secret://")) return null;
        const name = decodeURIComponent(ref.slice("secret://".length));
        const orgId = orgContext.getStore()?.organizationId ?? "";
        return this.entries.get(`${orgId}|${name}`) ?? null;
      }
      async put(name: string, value: string): Promise<SecretRef> {
        const orgId = orgContext.getStore()?.organizationId ?? "";
        this.entries.set(`${orgId}|${name}`, value);
        return ("secret://" + encodeURIComponent(name)) as SecretRef;
      }
      async delete(_nameOrRef: string): Promise<void> {}
      async list(_prefix?: string): Promise<SecretListEntry[]> {
        return [];
      }
    }
    const orgBacking = new OrgAwareStore();
    const orgRegistry = new SecretStoreRegistry(orgBacking, {
      secret: orgBacking,
    });

    // Seed the same logical ref under two different orgs with two
    // different values.
    const ref = await orgContext.run({ organizationId: "org-a" }, () =>
      orgRegistry.put("api/key", "alpha")
    );
    await orgContext.run({ organizationId: "org-b" }, () =>
      orgRegistry.put("api/key", "beta")
    );

    // Org A reads first to populate cache, then Org B must NOT see "alpha".
    const readA = await orgContext.run({ organizationId: "org-a" }, () =>
      orgRegistry.get(ref)
    );
    const readB = await orgContext.run({ organizationId: "org-b" }, () =>
      orgRegistry.get(ref)
    );
    expect(readA).toBe("alpha");
    expect(readB).toBe("beta");

    // Confirm the cache actually fired (drop backing, repeat reads).
    orgBacking.entries.clear();
    const readACached = await orgContext.run({ organizationId: "org-a" }, () =>
      orgRegistry.get(ref)
    );
    const readBCached = await orgContext.run({ organizationId: "org-b" }, () =>
      orgRegistry.get(ref)
    );
    expect(readACached).toBe("alpha");
    expect(readBCached).toBe("beta");
  });
});

describe("SecretStoreRegistry multi-backend routing", () => {
  test("deleteSecretsByPrefix cascades across every writable backend", async () => {
    const defaultStore = new InMemoryWritableStore();
    const customStore = new InMemoryWritableStore("custom", "in-memory");

    const registry = new SecretStoreRegistry(defaultStore, {
      secret: defaultStore,
      custom: customStore,
    });

    await registry.put("agents/a/openai", "sk-default");
    await customStore.put("agents/a/alt", "sk-custom");

    const listed = await registry.list("agents/a/");
    expect(listed).toHaveLength(2);

    const removed = await deleteSecretsByPrefix(registry, "agents/a/");
    expect(removed).toBe(2);
    expect(await registry.list("agents/a/")).toHaveLength(0);
    expect(customStore.size()).toBe(0);
  });

  test("delete() is a no-op (warns) for read-only backends", async () => {
    const defaultStore = new InMemoryWritableStore();
    const registry = new SecretStoreRegistry(
      defaultStore,
      { secret: defaultStore },
      { readOnlyStores: { "aws-sm": new ReadOnlyAwsStub() } }
    );

    await registry.delete("aws-sm://foo");
    const ref = await registry.put("agents/a/key", "hello");
    expect(await registry.get(ref)).toBe("hello");
  });
});

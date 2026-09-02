import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistryService } from "../services/provider-registry-service";

const REGISTRY_FIXTURE = {
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      providers: [
        {
          displayName: "OpenAI",
          envVarName: "OPENAI_API_KEY",
          upstreamBaseUrl: "https://api.openai.com/v1",
          sdkCompat: "openai",
        },
      ],
    },
  ],
};

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("ProviderRegistryService — failed load is retryable", () => {
  test("a load that failed before the file existed succeeds on a later call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lobu-registry-"));
    const path = join(dir, "providers.json");
    cleanup = () => rm(dir, { recursive: true, force: true });

    const service = new ProviderRegistryService(path);

    // First read fails: the file is not there yet (a config volume that has not
    // mounted). This used to latch permanently, so the egress judge would fail
    // closed forever with no path back short of a process restart.
    expect(Object.keys(await service.getProviderConfigs())).toHaveLength(0);

    await writeFile(path, JSON.stringify(REGISTRY_FIXTURE));

    // The cooldown gates a RETRY, not the first failure, so reach past it the
    // way wall-clock would.
    (service as unknown as { retryLoadAfter: number }).retryLoadAfter = 0;

    const configs = await service.getProviderConfigs();
    expect(Object.keys(configs).length).toBeGreaterThan(0);
    expect(configs.openai?.sdkCompat).toBe("openai");
  });

  test("does not re-read while the cooldown is still running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lobu-registry-cd-"));
    const path = join(dir, "providers.json");
    cleanup = () => rm(dir, { recursive: true, force: true });

    const service = new ProviderRegistryService(path);
    expect(Object.keys(await service.getProviderConfigs())).toHaveLength(0);

    // The file appears immediately after the failed read. Within the cooldown
    // the service must NOT go back to disk — otherwise a permanently absent
    // registry is re-read on every judged request.
    // A REAL provider, so a re-read is detectable: if the cooldown were not
    // enforced this call would return it.
    await writeFile(path, JSON.stringify(REGISTRY_FIXTURE));
    expect(Object.keys(await service.getProviderConfigs())).toHaveLength(0);
  });
});

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as credentials from "../../internal/credentials";
import * as deviceState from "../../internal/device-state";
import * as apiClient from "../../internal/api-client";
import * as context from "../../internal/context";
import { deviceWizard, type DeviceWizardPrompts } from "../_lib/device-wizard";

/**
 * The wizard is interactive (TTY-only), so its branch logic is unit-tested here
 * by injecting fake prompts plus stubbed remote calls. This pins the decisions
 * that matter for identity consistency: existing-device reuse vs a freshly
 * confirmed id, and the org the summary targets.
 */

function mockContext(): void {
  spyOn(context, "resolveContext").mockResolvedValue({
    name: "local",
    url: "http://127.0.0.1:8795",
    source: "config",
  });
  spyOn(credentials, "getToken").mockResolvedValue("local-token");
}

function fakePrompts(
  overrides: Partial<DeviceWizardPrompts> = {}
): DeviceWizardPrompts {
  return {
    select: async () => "personal",
    confirm: async () => true,
    input: async () => "macos:custom",
    ...overrides,
  };
}

function stubFetch(body: { devices?: unknown[] } | { error: string }): void {
  const hasError = Object.hasOwn(body as object, "error");
  const raw = JSON.stringify(body);
  spyOn(globalThis, "fetch").mockResolvedValue({
    ok: !hasError,
    status: hasError ? 401 : 200,
    statusText: hasError ? "Unauthorized" : "OK",
    json: async () => body,
    text: async () => raw,
  } as never);
}

function stubSave(): void {
  spyOn(deviceState, "saveDeviceState").mockResolvedValue({
    workerId: "macos:Mac",
    workerTokenPrefix: null,
    registeredAt: new Date().toISOString(),
  });
}

afterEach(() => {
  mock.restore();
});

describe("deviceWizard", () => {
  test("confirms the suggested id and persists it when there are no remote devices", async () => {
    mockContext();
    spyOn(apiClient, "listOrganizations").mockResolvedValue([
      { slug: "personal", personal: true },
    ]);
    stubFetch({ error: "Unauthorized" });
    stubSave();

    const result = await deviceWizard({
      suggestedWorkerId: "macos:Mac",
      prompts: fakePrompts(),
    });

    expect(result.source).toBe("created");
    expect(result.workerId).toBe("macos:Mac");
  });

  test("uses a custom id when the user declines the suggested one", async () => {
    mockContext();
    spyOn(apiClient, "listOrganizations").mockResolvedValue([
      { slug: "personal", personal: true },
    ]);
    stubFetch({ error: "Unauthorized" });
    const saveSpy = spyOn(deviceState, "saveDeviceState").mockResolvedValue({
      workerId: "macos:custom",
      workerTokenPrefix: null,
      registeredAt: new Date().toISOString(),
    });

    const result = await deviceWizard({
      suggestedWorkerId: "macos:Mac",
      prompts: fakePrompts({
        confirm: async () => false,
        input: async () => "macos:custom",
      }),
    });

    expect(result.workerId).toBe("macos:custom");
    expect(saveSpy.mock.calls[0]?.[1]?.workerId).toBe("macos:custom");
  });

  test("reuses an existing registered device id when the user picks one", async () => {
    mockContext();
    spyOn(apiClient, "listOrganizations").mockResolvedValue([
      { slug: "personal", personal: true },
    ]);
    stubFetch({
      devices: [
        {
          id: "dev-1",
          worker_id: "macos:existing-box",
          platform: "macos",
          label: "My Mac",
          organization_slug: "personal",
          organization_name: "Personal",
        },
      ],
    });
    const saveSpy = spyOn(deviceState, "saveDeviceState").mockResolvedValue({
      workerId: "macos:existing-box",
      workerTokenPrefix: null,
      registeredAt: new Date().toISOString(),
    });

    const result = await deviceWizard({
      suggestedWorkerId: "macos:Mac",
      prompts: fakePrompts({
        select: async () => "macos:existing-box" as unknown as string,
      }),
    });

    expect(result.source).toBe("reused");
    expect(result.workerId).toBe("macos:existing-box");
    expect(saveSpy.mock.calls[0]?.[1]?.workerId).toBe("macos:existing-box");
  });

  test("falls back to the fresh-id branch when the user picks start-new", async () => {
    mockContext();
    spyOn(apiClient, "listOrganizations").mockResolvedValue([
      { slug: "personal", personal: true },
    ]);
    stubFetch({
      devices: [
        {
          id: "dev-1",
          worker_id: "macos:other",
          platform: "macos",
          label: "Old",
          organization_slug: null,
          organization_name: null,
        },
      ],
    });
    stubSave();

    const result = await deviceWizard({
      suggestedWorkerId: "macos:Mac",
      prompts: fakePrompts({
        select: async () => "__new__" as unknown as string,
      }),
    });

    expect(result.source).toBe("created");
    expect(result.workerId).toBe("macos:Mac");
  });
});

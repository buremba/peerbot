import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as deviceState from "../../internal/device-state";
import { deviceWizard, type DeviceWizardPrompts } from "../_lib/device-wizard";

const GATEWAY_ORIGIN = "http://127.0.0.1:8795";
const WORKER_TOKEN = "owl_pat_durable-device-token";

function fakePrompts(
  overrides: Partial<DeviceWizardPrompts> = {}
): DeviceWizardPrompts {
  return {
    select: async () => "__lobu_new_device__",
    confirm: async () => true,
    input: async () => "macos:custom",
    ...overrides,
  };
}

function wizardOptions(
  overrides: Partial<Parameters<typeof deviceWizard>[0]> = {}
): Parameters<typeof deviceWizard>[0] {
  return {
    context: "local",
    gatewayOrigin: GATEWAY_ORIGIN,
    platform: "macos",
    suggestedWorkerId: "macos:Mac",
    workerApiToken: WORKER_TOKEN,
    prompts: fakePrompts(),
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Unauthorized",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as never;
}

function stubDevices(
  devices: unknown[],
  status = 200
): ReturnType<typeof spyOn> {
  return spyOn(globalThis, "fetch").mockResolvedValue(
    response(status === 200 ? { devices } : { error: "Unauthorized" }, status)
  );
}

function stubSave(): ReturnType<typeof spyOn> {
  return spyOn(deviceState, "saveDeviceState").mockResolvedValue();
}

afterEach(() => {
  mock.restore();
});

describe("deviceWizard", () => {
  test("confirms and persists a fresh identity without a no-op workspace prompt", async () => {
    stubDevices([]);
    const save = stubSave();
    const select = mock(async () => "__lobu_new_device__");
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    const result = await deviceWizard(
      wizardOptions({ prompts: fakePrompts({ select }) })
    );

    expect(result).toEqual({ source: "created", workerId: "macos:Mac" });
    expect(select).not.toHaveBeenCalled();
    expect(save.mock.calls[0]).toEqual([
      "local",
      "macos",
      { workerId: "macos:Mac" },
    ]);
    expect(logs.join("\n")).not.toContain("Token:");
    expect(logs.join("\n")).not.toContain("selected workspace");
  });

  test("uses a custom id when the user declines the suggestion", async () => {
    stubDevices([]);
    const save = stubSave();

    const result = await deviceWizard(
      wizardOptions({
        prompts: fakePrompts({
          confirm: async () => false,
          input: async () => "macos:custom",
        }),
      })
    );

    expect(result).toEqual({ source: "created", workerId: "macos:custom" });
    expect(save.mock.calls[0]?.[2]).toEqual({ workerId: "macos:custom" });
  });

  test("offers only offline devices from the daemon platform", async () => {
    stubDevices([
      {
        id: "matching-offline",
        worker_id: "macos:offline",
        platform: "macos",
        online: false,
        label: "Offline Mac",
      },
      {
        id: "wrong-platform",
        worker_id: "headless:box",
        platform: "headless",
        online: false,
      },
      {
        id: "matching-online",
        worker_id: "macos:online",
        platform: "macos",
        online: true,
      },
    ]);
    stubSave();
    const offered: string[] = [];

    const result = await deviceWizard(
      wizardOptions({
        prompts: fakePrompts({
          select: async (config) => {
            offered.push(
              ...config.choices.flatMap((choice) =>
                "value" in choice ? [String(choice.value)] : []
              )
            );
            return "matching-offline";
          },
        }),
      })
    );

    expect(result).toEqual({ source: "reused", workerId: "macos:offline" });
    expect(offered).toContain("matching-offline");
    expect(offered).not.toContain("wrong-platform");
    expect(offered).not.toContain("matching-online");
  });

  test("reports the reused device's server workspace", async () => {
    stubDevices([
      {
        id: "dev-b",
        worker_id: "macos:org-b-device",
        platform: "macos",
        online: false,
        organization_slug: "org-b",
      },
    ]);
    stubSave();
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    await deviceWizard(
      wizardOptions({
        prompts: fakePrompts({ select: async () => "dev-b" }),
      })
    );

    expect(logs.join("\n")).toContain('server workspace: "org-b"');
  });

  test("a new id matching an offline device reuses it instead of duplicating", async () => {
    stubDevices([
      {
        id: "same-box",
        worker_id: "macos:Mac",
        platform: "macos",
        online: false,
        organization_slug: "org-a",
      },
    ]);
    const save = stubSave();

    const result = await deviceWizard(
      wizardOptions({
        prompts: fakePrompts({ select: async () => "__lobu_new_device__" }),
      })
    );

    expect(result).toEqual({ source: "reused", workerId: "macos:Mac" });
    expect(save.mock.calls[0]?.[2]).toEqual({ workerId: "macos:Mac" });
  });

  test("rejects a new id already bound to another platform", async () => {
    stubDevices([
      {
        id: "other-platform",
        worker_id: "macos:Mac",
        platform: "headless",
        online: false,
      },
    ]);
    const save = stubSave();

    await expect(deviceWizard(wizardOptions())).rejects.toThrow(
      /registered as headless/
    );
    expect(save).not.toHaveBeenCalled();
  });

  test("rejects a new id that is already online", async () => {
    stubDevices([
      {
        id: "already-running",
        worker_id: "macos:Mac",
        platform: "macos",
        online: true,
      },
    ]);
    const save = stubSave();

    await expect(deviceWizard(wizardOptions())).rejects.toThrow(
      /already online/
    );
    expect(save).not.toHaveBeenCalled();
  });

  test("device-list failures stop setup instead of creating a duplicate", async () => {
    stubDevices([], 401);
    const save = stubSave();

    await expect(deviceWizard(wizardOptions())).rejects.toThrow(
      /Could not list devices.*Unauthorized/s
    );
    expect(save).not.toHaveBeenCalled();
  });

  test("uses the durable worker PAT only against the resolved gateway", async () => {
    const fetchSpy = stubDevices([]);
    stubSave();

    await deviceWizard(wizardOptions());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit];
    expect(String(input)).toBe(`${GATEWAY_ORIGIN}/api/me/devices`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${WORKER_TOKEN}`
    );
  });
});

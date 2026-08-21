import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as deviceState from "../../internal/device-state";
import { deviceWizard, type DeviceWizardPrompts } from "../_lib/device-wizard";

const API_URL = "http://127.0.0.1:8795";
const WORKER_TOKEN = "owl_pat_durable-device-token";

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

function wizardOptions(
  overrides: Partial<Parameters<typeof deviceWizard>[0]> = {}
): Parameters<typeof deviceWizard>[0] {
  return {
    context: "local",
    apiUrl: API_URL,
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

function stubFetch(options: {
  devices?: unknown[];
  devicesStatus?: number;
  tokenOrg?: string;
}): ReturnType<typeof spyOn> {
  return spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/userinfo")) {
      return response({
        organization_slug: options.tokenOrg ?? "personal",
        personal_org_slug: "personal",
        organizations: [
          { slug: "personal", name: "Personal", personal: true },
          { slug: "org-a", name: "Org A", personal: false },
          { slug: "org-b", name: "Org B", personal: false },
        ],
      });
    }
    return response(
      options.devicesStatus === 200 || options.devicesStatus === undefined
        ? { devices: options.devices ?? [] }
        : { error: "Unauthorized" },
      options.devicesStatus ?? 200
    );
  });
}

function stubSave(workerId = "macos:Mac"): ReturnType<typeof spyOn> {
  return spyOn(deviceState, "saveDeviceState").mockResolvedValue({ workerId });
}

afterEach(() => {
  mock.restore();
});

describe("deviceWizard", () => {
  test("confirms and persists a fresh identity when the server has no devices", async () => {
    stubFetch({ devices: [] });
    const save = stubSave();

    const result = await deviceWizard(wizardOptions());

    expect(result).toEqual({ source: "created", workerId: "macos:Mac" });
    expect(save.mock.calls[0]?.[1]).toEqual({ workerId: "macos:Mac" });
  });

  test("uses a custom id when the user declines the suggestion", async () => {
    stubFetch({ devices: [] });
    const save = stubSave("macos:custom");

    const result = await deviceWizard(
      wizardOptions({
        prompts: fakePrompts({
          confirm: async () => false,
          input: async () => "macos:custom",
        }),
      })
    );

    expect(result.workerId).toBe("macos:custom");
    expect(save.mock.calls[0]?.[1]).toEqual({ workerId: "macos:custom" });
  });

  test("maps a selected server device id back to its exact worker identity", async () => {
    stubFetch({
      devices: [
        {
          id: "dev-1",
          worker_id: "__new__",
          platform: "macos",
          label: "Literal sentinel worker",
          organization_slug: "personal",
        },
      ],
    });
    stubSave("__new__");
    const selections = ["personal", "dev-1"];

    const result = await deviceWizard(
      wizardOptions({
        prompts: fakePrompts({ select: async () => selections.shift() ?? "" }),
      })
    );

    expect(result).toEqual({ source: "reused", workerId: "__new__" });
  });

  test("cross-org reuse reports the server org and never claims the selected workspace is the pin", async () => {
    stubFetch({
      tokenOrg: "org-a",
      devices: [
        {
          id: "dev-b",
          worker_id: "macos:org-b-device",
          platform: "macos",
          label: "Org B Mac",
          organization_slug: "org-b",
          organization_name: "Org B",
        },
      ],
    });
    stubSave("macos:org-b-device");
    const selections = ["org-a", "dev-b"];
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    const result = await deviceWizard(
      wizardOptions({
        prompts: fakePrompts({ select: async () => selections.shift() ?? "" }),
      })
    );

    const output = logs.join("\n");
    expect(result).toEqual({
      source: "reused",
      workerId: "macos:org-b-device",
    });
    expect(output).toContain('server reports workspace "org-b"');
    expect(output).toContain('selected workspace "org-a" was guidance only');
    expect(output).not.toContain('Device workspace: "org-a"');
    expect(output).not.toContain("org-scoped to org-a");
  });

  test("a new device says only that the worker PAT determines attachment", async () => {
    stubFetch({ devices: [], tokenOrg: "org-a" });
    stubSave();
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    await deviceWizard(wizardOptions());

    const output = logs.join("\n");
    expect(output).toContain(
      "WORKER_API_TOKEN determines its workspace attachment on first poll"
    );
    expect(output).not.toContain("Device workspace:");
    expect(output).not.toContain("org-scoped to");
  });

  test("device-list failures stop setup instead of silently creating a duplicate", async () => {
    stubFetch({ devicesStatus: 401 });
    const save = stubSave();

    await expect(deviceWizard(wizardOptions())).rejects.toThrow(
      /Could not list devices.*Unauthorized/s
    );
    expect(save).not.toHaveBeenCalled();
  });

  test("uses only the durable worker PAT against the daemon origin", async () => {
    const fetchSpy = stubFetch({ devices: [] });
    stubSave();

    await deviceWizard(
      wizardOptions({ apiUrl: "https://gateway.example.test/api/v1" })
    );

    expect(fetchSpy).toHaveBeenCalled();
    for (const [input, init] of fetchSpy.mock.calls) {
      expect(String(input).startsWith("https://gateway.example.test/")).toBe(
        true
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${WORKER_TOKEN}`
      );
    }
  });

  test("returns the first-writer cache identity from an overlapping first boot", async () => {
    stubFetch({ devices: [] });
    stubSave("macos:other-process-won");

    const result = await deviceWizard(wizardOptions());

    expect(result.workerId).toBe("macos:other-process-won");
  });
});

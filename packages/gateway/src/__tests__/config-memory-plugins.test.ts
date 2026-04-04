import { afterEach, describe, expect, test } from "bun:test";
import { buildMemoryPlugins } from "../config";

const originalMemoryUrl = process.env.MEMORY_URL;
const originalDispatcherServiceName = process.env.DISPATCHER_SERVICE_NAME;
const originalKubernetesNamespace = process.env.KUBERNETES_NAMESPACE;

afterEach(() => {
  if (originalMemoryUrl === undefined) {
    delete process.env.MEMORY_URL;
  } else {
    process.env.MEMORY_URL = originalMemoryUrl;
  }

  if (originalDispatcherServiceName === undefined) {
    delete process.env.DISPATCHER_SERVICE_NAME;
  } else {
    process.env.DISPATCHER_SERVICE_NAME = originalDispatcherServiceName;
  }

  if (originalKubernetesNamespace === undefined) {
    delete process.env.KUBERNETES_NAMESPACE;
  } else {
    process.env.KUBERNETES_NAMESPACE = originalKubernetesNamespace;
  }
});

describe("buildMemoryPlugins", () => {
  test("returns native memory when MEMORY_URL is unset and plugin exists", () => {
    delete process.env.MEMORY_URL;

    expect(buildMemoryPlugins({ hasNativeMemoryPlugin: true })).toEqual([
      {
        source: "@openclaw/native-memory",
        slot: "memory",
        enabled: true,
      },
    ]);
  });

  test("returns no plugin when MEMORY_URL is unset and native memory is unavailable", () => {
    delete process.env.MEMORY_URL;

    expect(buildMemoryPlugins({ hasNativeMemoryPlugin: false })).toEqual([]);
  });

  test("falls back to native memory when Owletto plugin is unavailable", () => {
    process.env.MEMORY_URL = "https://memory.example.com";

    expect(
      buildMemoryPlugins({
        hasOwlettoPlugin: false,
        hasNativeMemoryPlugin: true,
      })
    ).toEqual([
      {
        source: "@openclaw/native-memory",
        slot: "memory",
        enabled: true,
      },
    ]);
  });

  test("returns no plugin when neither Owletto nor native memory plugin exists", () => {
    process.env.MEMORY_URL = "https://memory.example.com";

    expect(
      buildMemoryPlugins({
        hasOwlettoPlugin: false,
        hasNativeMemoryPlugin: false,
      })
    ).toEqual([]);
  });

  test("uses Owletto plugin when installed and MEMORY_URL is set", () => {
    process.env.MEMORY_URL = "https://memory.example.com";
    process.env.DISPATCHER_SERVICE_NAME = "lobu-gateway";
    process.env.KUBERNETES_NAMESPACE = "lobu";

    expect(buildMemoryPlugins({ hasOwlettoPlugin: true })).toEqual([
      {
        source: "@lobu/owletto-openclaw",
        slot: "memory",
        enabled: true,
        config: {
          mcpUrl: "http://lobu-gateway.lobu.svc.cluster.local:8080/mcp/owletto",
          gatewayAuthUrl: "http://lobu-gateway.lobu.svc.cluster.local:8080",
        },
      },
    ]);
  });
});

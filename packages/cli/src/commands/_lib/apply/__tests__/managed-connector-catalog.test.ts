import { afterEach, describe, expect, test } from "bun:test";
import {
  buildManagedMcpConnectorSource,
  hydrateManagedConnectorCatalog,
  isManagedCloudTarget,
} from "../managed-connector-catalog.js";
import type { DesiredState } from "../desired-state.js";

function managedState(
  connections: Array<{
    slug: string;
    connector: string;
    organization?: string;
  }>
): DesiredState {
  return {
    agents: [],
    prune: false,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    automations: [],
    connectors: {
      definitions: [],
      authProfiles: [],
      connections: connections.map(({ slug, connector, organization }) => ({
        slug,
        connector,
        config: organization
          ? { managedBy: { org: organization, connectionSlug: slug } }
          : undefined,
        feeds: [],
        sourceFile: "lobu.config.ts",
      })),
    },
    providers: [],
    requiredSecrets: [],
  };
}

describe("hydrateManagedConnectorCatalog", () => {
  test("hydrates one missing connector from its authenticated Cloud org", async () => {
    const requestedOrgs: string[] = [];
    const result = await hydrateManagedConnectorCatalog(
      managedState([
        {
          slug: "atlassian-burak",
          connector: "mcp.atlassian",
          organization: "lobu-managed",
        },
      ]),
      [],
      async (organization) => {
        requestedOrgs.push(organization);
        return [
          {
            id: 91,
            key: "mcp.atlassian",
            name: "Atlassian",
            version: "1.2.3",
            installed: true,
            auth_schema: {
              methods: [{ type: "oauth", provider: "mcp.atlassian" }],
            },
            mcp_config: {
              upstream_url: "https://mcp.atlassian.com/v1/mcp/authv2",
              tool_prefix: "atlassian",
            },
          },
        ];
      }
    );

    expect(requestedOrgs).toEqual(["lobu-managed"]);
    expect(result).toEqual([
      {
        key: "mcp.atlassian",
        name: "Atlassian",
        version: "1.2.3",
        installed: false,
        installable: true,
        catalog_origin: "managed",
        source_uri: null,
        mcp_config: {
          upstream_url: "https://mcp.atlassian.com/v1/mcp/authv2",
          tool_prefix: "atlassian",
        },
        auth_schema: {
          methods: [{ type: "oauth", provider: "mcp.atlassian" }],
        },
        managed_mcp_source: expect.stringContaining(
          '"upstream_url":"https://mcp.atlassian.com/v1/mcp/authv2"'
        ),
      },
    ]);
  });

  test("does not contact Cloud for an installed or bundled local connector", async () => {
    const state = managedState([
      {
        slug: "gmail",
        connector: "gmail",
        organization: "lobu-managed",
      },
      {
        slug: "atlassian",
        connector: "mcp.atlassian",
        organization: "lobu-managed",
      },
    ]);
    const local = [
      { key: "gmail", installed: true },
      {
        key: "mcp.atlassian",
        installed: false,
        installable: true,
        source_uri: "file:///catalog/atlassian.ts",
      },
    ];
    const result = await hydrateManagedConnectorCatalog(
      state,
      local,
      async () => {
        throw new Error("Cloud should not be contacted");
      }
    );
    expect(result).toBe(local);
  });

  test("fails closed when Cloud has no portable HTTPS MCP definition", async () => {
    await expect(
      hydrateManagedConnectorCatalog(
        managedState([
          {
            slug: "atlassian",
            connector: "mcp.atlassian",
            organization: "lobu-managed",
          },
        ]),
        [],
        async () => [
          {
            key: "mcp.atlassian",
            installed: true,
            mcp_config: { upstream_url: "http://internal.test/mcp" },
          },
        ]
      )
    ).rejects.toThrow(/does not expose an installed HTTPS MCP definition/);
  });

  test("fails closed when the same connector key resolves to different servers", async () => {
    await expect(
      hydrateManagedConnectorCatalog(
        managedState([
          { slug: "one", connector: "mcp.shared", organization: "org-one" },
          { slug: "two", connector: "mcp.shared", organization: "org-two" },
        ]),
        [],
        async (organization) => [
          {
            key: "mcp.shared",
            installed: true,
            mcp_config: {
              upstream_url: `https://${organization}.example.test/mcp`,
            },
          },
        ]
      )
    ).rejects.toThrow(/resolves to different definitions/);
  });

  test("fails closed when Cloud orgs disagree on one connector manifest", async () => {
    await expect(
      hydrateManagedConnectorCatalog(
        managedState([
          { slug: "one", connector: "mcp.shared", organization: "org-one" },
          { slug: "two", connector: "mcp.shared", organization: "org-two" },
        ]),
        [],
        async (organization) => [
          {
            key: "mcp.shared",
            installed: true,
            mcp_config: {
              upstream_url: "https://shared.example.test/mcp",
              tool_prefix: organization,
            },
          },
        ]
      )
    ).rejects.toThrow(/resolves to different definitions/);
  });

  test("refreshes an installed dynamic MCP definition while preserving its local identity", async () => {
    const result = await hydrateManagedConnectorCatalog(
      managedState([
        {
          slug: "atlassian",
          connector: "mcp.atlassian",
          organization: "lobu-managed",
        },
      ]),
      [
        {
          id: 44,
          key: "mcp.atlassian",
          installed: true,
          installable: false,
          version: "1.0.0",
          source_uri: null,
          mcp_config: {
            upstream_url: "https://mcp.atlassian.com/v1/mcp/authv2",
            tool_prefix: "old-prefix",
          },
        },
      ],
      async () => [
        {
          id: 91,
          key: "mcp.atlassian",
          name: "Atlassian",
          installed: true,
          version: "2.0.0",
          mcp_config: {
            upstream_url: "https://mcp.atlassian.com/v1/mcp/authv2",
            tool_prefix: "atlassian",
          },
        },
      ]
    );

    expect(result[0]).toMatchObject({
      id: 44,
      key: "mcp.atlassian",
      installed: true,
      version: "2.0.0",
      mcp_config: {
        upstream_url: "https://mcp.atlassian.com/v1/mcp/authv2",
        tool_prefix: "atlassian",
      },
    });
    expect(result[0]?.managed_mcp_source).toContain('"version":"2.0.0"');
  });

  test("does not refresh an installed dynamic MCP definition that matches Cloud", async () => {
    const matchingDefinition = {
      key: "mcp.atlassian",
      name: "Atlassian",
      installed: true,
      version: "2.0.0",
      source_uri: null,
      auth_schema: {
        methods: [{ type: "oauth", provider: "mcp.atlassian" }],
      },
      mcp_config: {
        upstream_url: "https://mcp.atlassian.com/v1/mcp/authv2",
        tool_prefix: "atlassian",
      },
    };
    const result = await hydrateManagedConnectorCatalog(
      managedState([
        {
          slug: "atlassian",
          connector: "mcp.atlassian",
          organization: "lobu-managed",
        },
      ]),
      [{ id: 44, installable: false, ...matchingDefinition }],
      async () => [{ id: 91, ...matchingDefinition }]
    );

    expect(result[0]).toMatchObject({ id: 44, installed: true });
    expect(result[0]?.managed_mcp_source).toBeUndefined();
  });
});

describe("buildManagedMcpConnectorSource", () => {
  test("builds fixed declarative source with no OAuth credential values", () => {
    const source = buildManagedMcpConnectorSource({
      key: "mcp.atlassian",
      name: "Atlassian",
      version: "1.2.3",
      auth_schema: {
        methods: [
          {
            type: "oauth",
            provider: "mcp.atlassian",
            clientIdKey: "MCP_CLIENT_ID",
            clientSecretKey: "MCP_CLIENT_SECRET",
          },
        ],
      },
      mcp_config: {
        upstream_url: "https://mcp.atlassian.com/v1/mcp/authv2",
        tool_prefix: "atlassian",
      },
    });

    expect(source).toContain("defineConnector");
    expect(source).toContain('"tool_prefix":"atlassian"');
    expect(source).not.toContain("access_token");
    expect(source).not.toContain("refresh_token");
  });

  test("rejects an MCP route that embeds credentials", () => {
    expect(() =>
      buildManagedMcpConnectorSource({
        key: "mcp.unsafe",
        installed: true,
        mcp_config: {
          upstream_url: "https://mcp.example.test/rpc?access_token=secret",
        },
      })
    ).toThrow(/no valid HTTPS MCP upstream URL/);
  });
});

describe("isManagedCloudTarget", () => {
  const originalCloudUrl = process.env.LOBU_CLOUD_URL;
  const originalCloudContext = process.env.LOBU_CLOUD_CONTEXT;

  afterEach(() => {
    if (originalCloudUrl === undefined) delete process.env.LOBU_CLOUD_URL;
    else process.env.LOBU_CLOUD_URL = originalCloudUrl;
    if (originalCloudContext === undefined) {
      delete process.env.LOBU_CLOUD_CONTEXT;
    } else {
      process.env.LOBU_CLOUD_CONTEXT = originalCloudContext;
    }
  });

  test("distinguishes the credential-holding Cloud from another remote runtime", async () => {
    process.env.LOBU_CLOUD_URL = "https://managed-cloud.example.test/api/v1";
    process.env.LOBU_CLOUD_CONTEXT = "managed-mcp-test-absent-context";

    expect(
      await isManagedCloudTarget("https://managed-cloud.example.test")
    ).toBe(true);
    expect(await isManagedCloudTarget("https://daytona.example.test")).toBe(
      false
    );
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as internal from "../../internal/index.js";
import { identitiesRekeyCommand } from "../identities.js";

interface RecordedCall {
  path: string;
  body: unknown;
}

let calls: RecordedCall[];
let responses: unknown[];
let tempDirectory: string | null;
let logged: string[];

beforeEach(() => {
  calls = [];
  responses = [];
  tempDirectory = null;
  logged = [];
  spyOn(internal, "resolveApiClient").mockImplementation(
    async () =>
      ({
        client: {
          post: async (path: string, body: unknown) => {
            calls.push({ path, body });
            return responses.shift() ?? {};
          },
        },
        contextName: "test",
        apiBaseUrl: "https://api.test",
        orgSlug: "testorg",
        token: "token",
      }) as never
  );
  spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  mock.restore();
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

async function mappingFile(mapping: Record<string, string | null>) {
  tempDirectory = await mkdtemp(join(tmpdir(), "lobu-identity-rekey-"));
  const path = join(tempDirectory, "mapping.json");
  await writeFile(path, JSON.stringify(mapping));
  return path;
}

describe("identities rekey", () => {
  test("--apply always dry-runs first, then repeats the exact complete mapping atomically", async () => {
    const mapping = { "101": "tenant-a", "102": "tenant-b", "103": null };
    const response = {
      action: "rekey_identities",
      namespace: "crm_customer",
      applied: false,
      live_identity_count: 3,
      changed_identity_count: 3,
      from_shapes: [],
      to_shape: {
        scope: "tenant" as const,
        scope_key_path: "metadata.tenant_id",
      },
    };
    responses = [response, { ...response, applied: true }];

    await identitiesRekeyCommand("crm_customer", {
      mapping: await mappingFile(mapping),
      apply: true,
      json: true,
    });

    expect(calls).toEqual([
      {
        path: "/api/testorg/manage_connections",
        body: {
          action: "rekey_identities",
          namespace: "crm_customer",
          mapping,
          apply: false,
        },
      },
      {
        path: "/api/testorg/manage_connections",
        body: {
          action: "rekey_identities",
          namespace: "crm_customer",
          mapping,
          apply: true,
        },
      },
    ]);
  });

  test("without --apply, issues the dry run and nothing else", async () => {
    responses = [
      {
        action: "rekey_identities",
        namespace: "crm_customer",
        applied: false,
        live_identity_count: 1,
        changed_identity_count: 1,
      },
    ];

    await identitiesRekeyCommand("crm_customer", {
      mapping: await mappingFile({ "101": "tenant-a" }),
    });

    expect(calls).toEqual([
      {
        path: "/api/testorg/manage_connections",
        body: {
          action: "rekey_identities",
          namespace: "crm_customer",
          mapping: { "101": "tenant-a" },
          apply: false,
        },
      },
    ]);
  });

  test("a rejected dry run never reaches the mutating call", async () => {
    responses = [{ error: "mapping omits 3 live identities" }];

    await expect(
      identitiesRekeyCommand("crm_customer", {
        mapping: await mappingFile({ "101": "tenant-a" }),
        apply: true,
      })
    ).rejects.toThrow(/mapping omits 3 live identities/);
    expect(calls).toHaveLength(1);
  });

  test("an applied=false response on --apply is reported as a failure", async () => {
    const response = {
      namespace: "crm_customer",
      applied: false,
      live_identity_count: 1,
      changed_identity_count: 1,
    };
    responses = [response, response];

    await expect(
      identitiesRekeyCommand("crm_customer", {
        mapping: await mappingFile({ "101": "tenant-a" }),
        apply: true,
      })
    ).rejects.toThrow(/reported applied=false/);
    expect(calls).toHaveLength(2);
  });

  test("reports the scope the server named, not an assumed one", async () => {
    responses = [
      {
        namespace: "crm_customer",
        live_identity_count: 4,
        changed_identity_count: 0,
        from_shapes: [
          { connector_key: "erp", scope: "organization", scope_key_path: null },
          {
            connector_key: "crm",
            scope: "tenant",
            scope_key_path: "metadata.account_id",
          },
        ],
        to_shape: { scope: "tenant", scope_key_path: "metadata.tenant_id" },
      },
    ];

    await identitiesRekeyCommand("crm_customer", {
      mapping: await mappingFile({ "101": "tenant-a" }),
    });

    const report = logged.join("\n");
    expect(report).toContain("erp -> organization");
    expect(report).toContain("crm -> tenant (metadata.account_id)");
    expect(report).toContain("tenant (metadata.tenant_id)");
  });

  test("rejects invalid identity ids before making a request", async () => {
    await expect(
      identitiesRekeyCommand("crm_customer", {
        mapping: await mappingFile({ "not-an-id": "tenant-a" }),
      })
    ).rejects.toThrow(/positive identity id/i);
    expect(calls).toEqual([]);
  });

  test("rejects empty tenant keys before making a request", async () => {
    await expect(
      identitiesRekeyCommand("crm_customer", {
        mapping: await mappingFile({ "101": "   " }),
      })
    ).rejects.toThrow(/empty tenant key/i);
    expect(calls).toEqual([]);
  });

  test("rejects padded tenant keys before making a request", async () => {
    await expect(
      identitiesRekeyCommand("crm_customer", {
        mapping: await mappingFile({ "101": " tenant-a" }),
      })
    ).rejects.toThrow(/leading or trailing whitespace/i);
    expect(calls).toEqual([]);
  });

  test("rejects NUL in tenant keys before making a request", async () => {
    await expect(
      identitiesRekeyCommand("crm_customer", {
        mapping: await mappingFile({ "101": "tenant\u0000a" }),
      })
    ).rejects.toThrow(/must not contain NUL/i);
    expect(calls).toEqual([]);
  });
});

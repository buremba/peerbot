import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as apiClient from "../../internal/api-client.js";
import { identitiesRekeyCommand } from "../identities.js";

type RecordedCall = { path: string; body: unknown };

const report = {
  namespace: "erp_customer",
  targetScope: "tenant" as const,
  targetScopeKeyPath: "metadata.tenant_id",
  connectorKeys: ["erp"],
  liveIdentityCount: 2,
  changes: [
    { id: "10", fromScopeKey: null, toScopeKey: "tenant-a" },
    { id: "11", fromScopeKey: null, toScopeKey: "tenant-b" },
  ],
  applied: false,
};

describe("identities rekey", () => {
  let fixtureDir: string;
  let mappingPath: string;
  let calls: RecordedCall[];
  let responses: unknown[];

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "lobu-identities-rekey-"));
    mappingPath = join(fixtureDir, "mapping.json");
    await writeFile(
      mappingPath,
      JSON.stringify({ 10: "tenant-a", 11: "tenant-b" })
    );
    calls = [];
    responses = [];
    spyOn(process.stdout, "write").mockImplementation(() => true);
    spyOn(console, "log").mockImplementation(() => undefined);
    spyOn(apiClient, "resolveApiClient").mockImplementation(
      async () =>
        ({
          client: {
            post: async (path: string, body: unknown) => {
              calls.push({ path, body });
              return responses.shift();
            },
          },
          orgSlug: "acme",
        }) as never
    );
  });

  afterEach(async () => {
    mock.restore();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  test("defaults to a single dry-run request", async () => {
    responses = [report];

    await identitiesRekeyCommand("erp_customer", {
      mapping: mappingPath,
      json: true,
    });

    expect(calls).toEqual([
      {
        path: "/api/acme/identities/rekey",
        body: {
          namespace: "erp_customer",
          mapping: { 10: "tenant-a", 11: "tenant-b" },
          apply: false,
        },
      },
    ]);
  });

  test("validates with a dry run before applying the same complete mapping", async () => {
    responses = [report, { ...report, applied: true }];

    await identitiesRekeyCommand("erp_customer", {
      mapping: mappingPath,
      apply: true,
      json: true,
    });

    expect(calls.map((call) => call.body)).toEqual([
      {
        namespace: "erp_customer",
        mapping: { 10: "tenant-a", 11: "tenant-b" },
        apply: false,
      },
      {
        namespace: "erp_customer",
        mapping: { 10: "tenant-a", 11: "tenant-b" },
        apply: true,
      },
    ]);
  });
});

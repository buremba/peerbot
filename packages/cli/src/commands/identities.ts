import { readFile } from "node:fs/promises";
import chalk from "chalk";
import { resolveApiClient } from "../internal/index.js";
import { printJson } from "../internal/output.js";
import type { CloudCommandOptions } from "./_lib/cloud-options.js";
import {
  ApiError,
  parseJsonObject,
  ValidationError,
} from "./memory/_lib/errors.js";

interface IdentityRekeyResponse {
  error?: string;
  action?: "rekey_identities";
  namespace?: string;
  applied?: boolean;
  live_identity_count?: number;
  changed_identity_count?: number;
  from_shapes?: Array<{
    connector_key: string;
    scope: string;
    scope_key_path: string | null;
  }>;
  to_shape?: {
    scope: string;
    scope_key_path: string | null;
  };
}

type IdentityMapping = Record<string, string | null>;

async function readIdentityMapping(path: string): Promise<IdentityMapping> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ValidationError(
      `Failed to read --mapping ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parsed = parseJsonObject(raw, `in --mapping ${path}`);
  const mapping: IdentityMapping = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!/^[1-9]\d*$/.test(id)) {
      throw new ValidationError(
        `--mapping key "${id}" is not a positive identity id.`
      );
    }
    if (value !== null && typeof value !== "string") {
      throw new ValidationError(
        `--mapping value for identity ${id} must be a tenant-key string or null.`
      );
    }
    if (typeof value === "string" && value.trim().length === 0) {
      throw new ValidationError(
        `--mapping value for identity ${id} must not be an empty tenant key.`
      );
    }
    mapping[id] = value;
  }
  return mapping;
}

function shapeText(
  shape: { scope: string; scope_key_path: string | null } | undefined
): string {
  if (!shape) return "unknown";
  return shape.scope_key_path
    ? `${shape.scope} (${shape.scope_key_path})`
    : shape.scope;
}

function printReport(
  report: IdentityRekeyResponse,
  label: string,
  namespace: string
): void {
  const current = (report.from_shapes ?? [])
    .map((item) => `${item.connector_key} -> ${shapeText(item)}`)
    .join(", ");
  console.log(chalk.bold(`\n  ${label}`));
  console.log(`  Namespace: ${namespace}`);
  console.log(`  Current:   ${current || "unknown"}`);
  console.log(`  Target:    ${shapeText(report.to_shape)}`);
  console.log(`  Live rows: ${report.live_identity_count ?? "unknown"}`);
  console.log(`  Changes:   ${report.changed_identity_count ?? "unknown"}`);
}

export async function identitiesRekeyCommand(
  namespace: string,
  options: CloudCommandOptions & {
    mapping: string;
    apply?: boolean;
  }
): Promise<void> {
  const mapping = await readIdentityMapping(options.mapping);
  const { client, orgSlug } = await resolveApiClient(options);
  const call = async (apply: boolean): Promise<IdentityRekeyResponse> => {
    const response = await client.post<IdentityRekeyResponse>(
      `/api/${orgSlug}/manage_connections`,
      {
        action: "rekey_identities",
        namespace,
        mapping,
        apply,
      }
    );
    if (response.error) throw new ApiError(response.error);
    return response;
  };

  // Even `--apply` issues and prints a fresh dry run first. The preview is for
  // the operator only: it is deliberately not a token the mutating call trusts,
  // so the `apply: true` request must re-validate the same mapping itself.
  const dryRun = await call(false);
  if (!options.apply) {
    if (options.json) printJson(dryRun);
    else {
      printReport(dryRun, `Identity re-key dry run for ${orgSlug}`, namespace);
      console.log(
        chalk.dim(
          "\n  No changes made. Re-run with --apply after reviewing this complete mapping.\n"
        )
      );
    }
    return;
  }

  if (!options.json)
    printReport(dryRun, `Identity re-key dry run for ${orgSlug}`, namespace);
  const applied = await call(true);
  if (options.json) {
    printJson({ dry_run: dryRun, applied });
    return;
  }
  printReport(applied, "Identity re-key applied atomically", namespace);
  console.log(
    chalk.green(
      "\n  Re-key complete. Re-run `lobu apply` for the connector change.\n"
    )
  );
}

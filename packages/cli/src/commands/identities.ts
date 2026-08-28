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
    if (value !== null) {
      // A tenant key is sent and compared verbatim, so anything the eye cannot
      // distinguish is rejected rather than repaired: padding would silently
      // split one tenant across two scope keys, and NUL cannot be stored in a
      // Postgres text column at all.
      if (value.trim().length === 0) {
        throw new ValidationError(
          `--mapping value for identity ${id} must not be an empty tenant key.`
        );
      }
      if (value !== value.trim()) {
        throw new ValidationError(
          `--mapping value for identity ${id} must not have leading or trailing whitespace.`
        );
      }
      if (value.includes("\u0000")) {
        throw new ValidationError(
          `--mapping value for identity ${id} must not contain NUL.`
        );
      }
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
  // `from_shapes` is the shape the rows are keyed by *before* the re-key, so it
  // is only the current shape while nothing has been written yet.
  if (!report.applied) console.log(`  Current:   ${current || "unknown"}`);
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
    // This command is intentionally released before the server action. #2849's
    // rollout contract requires the CLI to exist before a newer server can
    // direct an operator here; an older server rejects this unknown action at
    // schema validation, before dispatch, so the compatibility window is safe.
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
  // The response echoes whether the mutation happened. `applied: false` on an
  // `apply: true` request contradicts it, so it must not be reported as a
  // completed re-key; a response that omits the field asserts nothing.
  if (applied.applied === false) {
    throw new ApiError(
      "Re-key was not applied: the server accepted the request but reported applied=false. Nothing changed."
    );
  }
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

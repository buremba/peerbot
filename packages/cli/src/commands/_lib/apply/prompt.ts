import { confirm } from "@inquirer/prompts";
import { ValidationError } from "../../memory/_lib/errors.js";

export interface ConfirmOptions {
  /** Skip the prompt and treat as approved. CI / scripted apply path. */
  yes: boolean;
  /** Plan summary line to show next to the prompt for confirmation context. */
  summaryLine: string;
}

/**
 * Block until the user explicitly accepts the plan. `--yes` short-circuits
 * to true. Non-TTY without `--yes` exits with a clear error rather than
 * trying to read from a closed stdin and hanging.
 */
export async function confirmPlan(opts: ConfirmOptions): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ValidationError(
      "stdin is not a TTY and --yes was not supplied. Re-run with --yes to apply non-interactively."
    );
  }
  return confirm({
    message: `Apply plan? (${opts.summaryLine})`,
    default: false,
  });
}

/**
 * Confirm provisioning a new organization — the `[memory].org` slug (or
 * `--org`) doesn't resolve to one of the operator's orgs yet. `yes`
 * short-circuits to true; non-TTY without `--yes` throws.
 */
export async function confirmCreateOrg(
  slug: string,
  name: string,
  yes: boolean
): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ValidationError(
      `Organization "${slug}" doesn't exist and --yes was not supplied. Re-run with --yes to create it non-interactively.`
    );
  }
  return confirm({
    message: `Organization "${slug}" doesn't exist. Create it now as "${name}"?`,
    default: false,
  });
}

/**
 * Confirm uploading + compiling custom connector source on the gateway.
 * `yes` short-circuits to true; non-TTY without `--yes` throws rather than
 * hanging on a closed stdin.
 */
export async function confirmCustomConnectors(yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ValidationError(
      "Custom connector source present and --yes was not supplied. Re-run with --yes once you've reviewed the connector code."
    );
  }
  return confirm({
    message: "Compile & execute these connectors on the gateway?",
    default: false,
  });
}

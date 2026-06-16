import { confirm } from "@inquirer/prompts";
import { ValidationError } from "../../memory/_lib/errors.js";

interface ConfirmOptions {
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
 * Extra blast-radius gate when a code-managed apply would delete more than a
 * handful of definitions. The plan confirm already shows the deletes; this is
 * a second, explicit "yes, delete N" so a large accidental prune (e.g. a config
 * pointed at the wrong org) can't sail through on a reflexive first y/N.
 * `yes` short-circuits (CI); non-TTY without `--yes` throws.
 */
export async function confirmDeletions(
  count: number,
  yes: boolean
): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ValidationError(
      `${count} definitions would be DELETED and --yes was not supplied. Re-run with --yes once you've reviewed the plan.`
    );
  }
  return confirm({
    message: `This will DELETE ${count} definitions removed from your config. Continue?`,
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

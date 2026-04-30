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

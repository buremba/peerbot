import { type ApplyOptions, applyCommand } from "./_lib/apply/apply-cmd.js";

export async function lobuApplyCommand(options: ApplyOptions): Promise<void> {
  await applyCommand(options);
}

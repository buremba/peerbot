import * as fs from "node:fs/promises";

interface SessionProviderContext {
  messages: readonly unknown[];
  model: { provider: string; modelId: string } | null;
}

interface SessionProviderReader {
  buildSessionContext(): SessionProviderContext;
}

/**
 * Keep transcripts isolated across provider changes without a local sidecar.
 * Pi persists the active provider in session.jsonl model_change/assistant
 * entries, so the transcript snapshot itself is the durable, cross-pod source
 * of truth. Missing metadata on a non-empty transcript fails closed.
 */
export async function resetSessionForProviderChange(opts: {
  sessionFile: string;
  sessionManager: SessionProviderReader;
  provider: string;
}): Promise<string | undefined> {
  const context = opts.sessionManager.buildSessionContext();
  if (context.messages.length === 0) return;

  const previousProvider = context.model?.provider?.trim();
  if (previousProvider === opts.provider) return;

  await fs.unlink(opts.sessionFile).catch((error) => {
    if (
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  });

  if (previousProvider) {
    return `[System note: The AI provider was just changed from ${previousProvider} to ${opts.provider}. Previous conversation history (${context.messages.length} messages) has been cleared. Continue helping the user from this point forward.]`;
  }

  return `[System note: The previous conversation's AI provider metadata was unavailable. Previous conversation history (${context.messages.length} messages) has been cleared before continuing with ${opts.provider}. Continue helping the user from this point forward.]`;
}

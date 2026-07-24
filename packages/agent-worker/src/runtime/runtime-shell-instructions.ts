/**
 * System-prompt guidance for where shell runs in this conversation.
 *
 * - No remote provider pin → local interpreter/shell limits (lightweight;
 *   steer away from heavy compute; point admins at adding a sandbox provider).
 * - Remote provider pin (e.g. vercel) → remote sticky sandbox note (lazy
 *   create, no create-sandbox tool).
 */

/** Known remote workspace roots by provider id (informational for the model). */
const REMOTE_WORKSPACE_HINT: Record<string, string> = {
  vercel: "/vercel/sandbox",
};

/**
 * Build shell-runtime instructions for the agent system prompt.
 * Always returns a short block — local limits or remote provider guidance.
 */
export function buildRuntimeShellInstructions(
  runtimeProviderId: string | null | undefined
): string {
  const id = runtimeProviderId?.trim().toLowerCase();
  if (!id) {
    return `## Shell runtime (this conversation)

- Shell runs in a **local interpreter environment** on the Lobu worker (lightweight just-bash / host-adjacent shell), **not** a dedicated remote compute sandbox.
- Treat this environment as **limited**: prefer Lobu tools (\`search_memory\`, MCP, SDK) over shell. Avoid CPU-, memory-, or time-heavy work (large builds, long compiles, heavy data processing, big downloads, load tests).
- If the user needs serious compute, isolated remote shell, or long-running jobs, tell them an admin can **add a sandbox provider** (e.g. Vercel) on this agent in Lobu settings — that pins a remote environment for the conversation. You cannot enable that yourself.
- Use the **bash** tool for light shell when needed. Users may type \`!cmd\` to run shell without you; you do not type \`!\`.
- Workspace paths are internal. Deliver user-facing files only via \`upload_file\`.`;
  }

  const workspaceHint = REMOTE_WORKSPACE_HINT[id];
  const workspaceLine = workspaceHint
    ? `- Shell working tree is under \`${workspaceHint}\` on the remote host (internal; not a user download path).`
    : `- Shell runs on remote provider \`${id}\` (internal paths are not user download links).`;

  return `## Shell runtime (this conversation)

- Shell runs in a **remote compute environment** for this conversation (provider: \`${id}\`).
- You do **not** create, open, or choose the sandbox — there is no create-sandbox tool. Infrastructure starts it on first bash use and reuses it for this conversation.
- Use the **bash** tool for shell. Users may type \`!cmd\` to run shell without you; you do not type \`!\`.
- Prefer Lobu tools (\`search_memory\`, MCP, SDK) over bash when a tool exists.
${workspaceLine}
- Deliver user-facing files only via \`upload_file\` after writing them. Never present remote workspace paths as download links.`;
}

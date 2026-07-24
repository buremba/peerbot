import { getWorkerRuntimeProvider } from "../embedded/runtime";

/**
 * System-prompt guidance for where shell runs in this conversation.
 *
 * The runtime registry is the source of truth: an absent or unregistered
 * provider id falls back to local just-bash, exactly like the backend selector.
 */
export function buildRuntimeShellInstructions(
  runtimeProviderId: string | undefined,
  bashEnabled: boolean
): string {
  if (!bashEnabled) {
    return `## Shell runtime (this conversation)

- Shell is disabled for this agent by policy. Do not attempt to use the \`bash\` tool or tell the user to run \`!cmd\`.`;
  }

  const runtimeProvider = getWorkerRuntimeProvider(runtimeProviderId);
  if (!runtimeProvider) {
    return `## Shell runtime (this conversation)

- Shell runs in a **local lightweight interpreter environment** on the Lobu worker, **not** a dedicated remote compute sandbox.
- Treat this environment as **limited**: prefer purpose-built Lobu or MCP tools over shell. Avoid CPU-, memory-, or time-heavy work (large builds, long compiles, heavy data processing, big downloads, load tests).
- If the user needs serious compute, isolated remote shell, or long-running jobs, tell them an admin can add a sandbox provider under Infrastructure and select its sandbox in the agent settings. New conversations will then use that remote environment. You cannot enable it yourself.
- Use the **bash** tool only for light shell work. Users may type \`!cmd\` to run shell without you; you do not type \`!\`.`;
  }

  const id = runtimeProvider.id;

  return `## Shell runtime (this conversation)

- Shell runs in a **remote compute environment** for this conversation (provider: \`${id}\`).
- You do **not** create, open, or choose the sandbox — there is no create-sandbox tool. Infrastructure starts it on first bash use and reuses it for this conversation.
- Use the **bash** tool for shell. Users may type \`!cmd\` to run shell without you; you do not type \`!\`.
- Prefer purpose-built Lobu or MCP tools over bash when one exists.`;
}

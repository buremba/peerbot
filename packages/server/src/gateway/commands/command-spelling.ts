const LOBU_WRAPPER_PLATFORMS = new Set(["slack", "gchat"]);

/** Render the advertised command spelling for the target platform. */
export function formatChatCommand(platform: string, name: string): string {
  return LOBU_WRAPPER_PLATFORMS.has(platform) ? `/lobu ${name}` : `/${name}`;
}

/** Stateful commands are handled by the message bridge, before dispatch. */
export function normalizeStatefulChatCommand(
  text: string,
): "new" | "clear" | null {
  const match = text
    .trim()
    .toLowerCase()
    .match(/^\/(?:lobu\s+)?(new|clear)$/);
  return match?.[1] === "new" || match?.[1] === "clear" ? match[1] : null;
}

/**
 * Generate a deterministic, readable agent ID from platform identity.
 * One-to-one mapping: each user/chat gets exactly one agent.
 *
 * Format:
 * - DM:    {platform}-{userId}       (e.g., telegram-6570514069, slack-U12345)
 * - Group: {platform}-g-{chatId}     (e.g., telegram-g--1001234567, slack-g-C12345)
 */
export function platformAgentId(
  platform: string,
  userId: string,
  chatId: string,
  isGroup: boolean
): string {
  if (isGroup) return `${platform}-g-${chatId}`;
  return `${platform}-${userId}`;
}

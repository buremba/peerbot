/** Platforms that support the hosted Lobu managed bot (link codes, channel bindings). */
export const MANAGED_CHAT_PLATFORMS = ["slack", "telegram"] as const;

export const MANAGED_CHAT_PLATFORMS_SET = new Set<string>(
	MANAGED_CHAT_PLATFORMS,
);

export function isManagedChatPlatform(platform: string): boolean {
	return MANAGED_CHAT_PLATFORMS_SET.has(platform);
}

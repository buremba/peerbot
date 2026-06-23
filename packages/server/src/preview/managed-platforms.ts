/** Platforms that support the hosted Lobu managed bot (link codes, channel bindings). */
export const MANAGED_CHAT_PLATFORMS = ["slack", "telegram"] as const;

export type ManagedChatPlatform = (typeof MANAGED_CHAT_PLATFORMS)[number];

export const MANAGED_CHAT_PLATFORMS_SET = new Set<string>(
	MANAGED_CHAT_PLATFORMS,
);

/** Optional one-click install affordances for managed platforms (UI metadata). */
export const MANAGED_PLATFORM_INSTALL: Partial<
	Record<ManagedChatPlatform, { path: string; label: string }>
> = {
	slack: { path: "/lobu/slack/install", label: "Add to Slack" },
};

export function isManagedChatPlatform(platform: string): boolean {
	return MANAGED_CHAT_PLATFORMS_SET.has(platform);
}

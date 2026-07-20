/** Platforms that support the hosted Lobu managed bot (link codes, channel Behaviors). */
export const MANAGED_CHAT_PLATFORMS = ["slack", "telegram"] as const;

export const MANAGED_CHAT_PLATFORMS_SET = new Set<string>(
	MANAGED_CHAT_PLATFORMS,
);

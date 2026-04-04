export interface PlatformAuthMethod {
  type: "oauth" | "claim-code";
}

const DEFAULT_AUTH_METHOD: PlatformAuthMethod = { type: "claim-code" };

const AUTH_METHODS: Record<string, PlatformAuthMethod> = {
  telegram: {
    type: "claim-code",
  },
};

export function getAuthMethod(platform: string): PlatformAuthMethod {
  return AUTH_METHODS[platform] || DEFAULT_AUTH_METHOD;
}

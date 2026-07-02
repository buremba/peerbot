import {
  getConfiguredPublicGatewayUrl,
  resolvePublicGatewayUrl,
} from "../../utils/public-origin.js";

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolvePublicBaseUrl(options?: {
  configuredUrl?: string;
  requestUrl?: string;
  fallbackUrl?: string;
}): string {
  // Explicit configuredUrl always wins (caller knows best)
  if (options?.configuredUrl) {
    return normalizeBaseUrl(options.configuredUrl);
  }

  // When only requestUrl is provided, prefer it over the env default
  // so OAuth redirects match the actual browser origin.
  if (options?.requestUrl) {
    const origin = new URL(options.requestUrl);
    return normalizeBaseUrl(origin.origin);
  }

  const configured = getConfiguredPublicGatewayUrl();
  if (configured) {
    return normalizeBaseUrl(configured);
  }

  return normalizeBaseUrl(
    options?.fallbackUrl || resolvePublicGatewayUrl()
  );
}

export function resolvePublicUrl(
  path: string,
  options?: {
    configuredUrl?: string;
    requestUrl?: string;
    fallbackUrl?: string;
  }
): string {
  return new URL(path, `${resolvePublicBaseUrl(options)}/`).toString();
}
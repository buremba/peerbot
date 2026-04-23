function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolvePublicBaseUrl(options?: {
  configuredUrl?: string;
  requestUrl?: string;
  forwardedProto?: string;
  fallbackUrl?: string;
}): string {
  // Explicit configuredUrl always wins (caller knows best)
  if (options?.configuredUrl) {
    return normalizeBaseUrl(options.configuredUrl);
  }

  // When only requestUrl is provided, prefer it over the env default
  // so OAuth redirects match the actual browser origin.
  // Respect X-Forwarded-Proto for TLS-terminating proxies — but only
  // when the value is one of the two legitimate protocols. A spoofed
  // value (e.g. attacker-controlled `X-Forwarded-Proto: javascript`)
  // would otherwise be welded into OAuth redirect URLs.
  if (options?.requestUrl) {
    const origin = new URL(options.requestUrl);
    if (options.forwardedProto) {
      const proto = options.forwardedProto.split(",")[0]?.trim().toLowerCase();
      if (proto === "http" || proto === "https") {
        origin.protocol = `${proto}:`;
      }
    }
    return normalizeBaseUrl(origin.origin);
  }

  if (process.env.PUBLIC_GATEWAY_URL) {
    return normalizeBaseUrl(process.env.PUBLIC_GATEWAY_URL);
  }

  return normalizeBaseUrl(options?.fallbackUrl || "http://localhost:8080");
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

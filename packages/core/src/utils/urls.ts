/**
 * Ensure URL has http:// or https:// prefix
 */
export function ensureBaseUrl(url: string): string {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return `http://${url}`;
  }
  return url;
}

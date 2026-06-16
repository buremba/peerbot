/**
 * Canonical URL-safe slug generator shared across packages.
 *
 * Lowercase, runs of non-alphanumeric characters collapse to a single hyphen,
 * leading/trailing hyphens trimmed. Returns an empty string when the input has
 * no alphanumeric characters (callers decide on a fallback).
 *
 * @example
 * slugify('Hello World')            // 'hello-world'
 * slugify('Café Münchën', { normalize: true }) // 'cafe-munchen'
 * slugify('x'.repeat(60), { maxLength: 32 })    // 32-char slug
 */
export function slugify(
  input: string,
  options?: { normalize?: boolean; maxLength?: number }
): string {
  let slug = input.toLowerCase();
  if (options?.normalize) {
    // Decompose accented characters and drop the combining diacritical marks
    // so e.g. "café" -> "cafe" instead of "caf".
    slug = slug.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  }
  slug = slug.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (options?.maxLength != null) slug = slug.slice(0, options.maxLength);
  return slug;
}

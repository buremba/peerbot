/**
 * Shared vocabulary for the `json_template` render DSL.
 *
 * The DSL is authored once per event kind / entity type and rendered on three
 * surfaces: the web app and MCP apps (owletto's `json-renderer`) and chat
 * notification delivery (the server's `template-card`). The *formatting* of a
 * bound scalar must agree across all three — a date that reads "Aug 19, 2026"
 * in the Memory view cannot read "2026-08-19T00:00:00Z" in Slack — so the
 * format directives and their implementation live here rather than being
 * reimplemented per surface.
 *
 * Structural node shapes stay with each renderer: the node vocabulary is
 * deliberately open (see the server's `validate-json-template`), and each
 * surface resolves components against its own registry.
 */

/**
 * Display-format directives a `data` binding (or a table column) can request.
 * Domain-agnostic on purpose — this knows how to format a currency/date/enum,
 * never which field is one; that comes from the JSON-Schema annotation resolved
 * by whoever authors the binding.
 */
export type ValueFormat =
  | "currency"
  | "date"
  | "url"
  | "enum"
  | "boolean"
  | "number"
  | "auto"
  | "text";

/** Every directive `formatValue` understands, for validating authored templates. */
export const VALUE_FORMATS: ReadonlySet<ValueFormat> = new Set<ValueFormat>([
  "currency",
  "date",
  "url",
  "enum",
  "boolean",
  "number",
  "auto",
  "text",
]);

export function isValueFormat(value: unknown): value is ValueFormat {
  return typeof value === "string" && VALUE_FORMATS.has(value as ValueFormat);
}

const DATE_STRING =
  /^\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function looksLikeDateString(value: string): boolean {
  return DATE_STRING.test(value);
}

export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** `pull_request_opened` → `Pull Request Opened`. */
function titleCaseWords(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000_000 ? 1 : 0,
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Compact `host/path` label for a URL; the caller decides link-ness. */
export function formatUrlLabel(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./i, "");
    const path =
      url.pathname && url.pathname !== "/"
        ? url.pathname.replace(/\/$/, "")
        : "";
    return `${host}${path}`;
  } catch {
    return value;
  }
}

function formatStructuredValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(formatValue(value));
  }
  if (Array.isArray(value)) {
    if (!value.some((item) => typeof item === "object" && item !== null)) {
      return JSON.stringify(value);
    }
    return value
      .map((item, index) => `${index + 1}. ${formatStructuredValue(item)}`)
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entryValue]) =>
        entryValue !== null && entryValue !== undefined && entryValue !== ""
    );
    return entries
      .map(
        ([key, entryValue]) =>
          `${titleCaseWords(key)}: ${formatStructuredValue(entryValue)}`
      )
      .join("; ");
  }
  return JSON.stringify(value);
}

/**
 * Format one bound value per an explicit directive.
 *
 * `format` omitted or `"text"` keeps scalar strings and numbers raw. `"auto"`
 * opts into shape inference (dates/urls, never currency), while specific formats
 * force that treatment. Booleans always render Yes/No; objects and object arrays
 * use compact line-item text, and primitive arrays stay in JSON form.
 */
export function formatValue(value: unknown, format?: ValueFormat): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (typeof value === "number") {
    if (format === "currency") return formatCurrency(value);
    if (format === undefined || format === "text") return String(value);
    return formatNumber(value);
  }

  if (typeof value !== "string") return formatStructuredValue(value);

  switch (format) {
    case "currency":
      return formatCurrency(Number(value));
    case "date":
      return formatDate(value);
    case "url":
      return formatUrlLabel(value);
    case "enum":
      return titleCaseWords(value);
    case "number":
      return formatNumber(Number(value));
    case "auto": {
      // Infer date/url from the value's shape, but never currency.
      if (isHttpUrl(value)) return formatUrlLabel(value);
      if (looksLikeDateString(value)) return formatDate(value);
      return value;
    }
    default:
      // undefined | "text" → raw passthrough (no silent reformatting).
      return value;
  }
}

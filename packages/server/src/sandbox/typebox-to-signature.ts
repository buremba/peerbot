/**
 * TypeBox schema → inline TypeScript signature formatter.
 *
 * Used by the `search` MCP tool (PR-2) to render method signatures as
 * copy-pasteable TS for LLMs. Walks a TypeBox schema and emits the
 * inline-expanded type with JSDoc comments derived from `description`.
 *
 * Design notes
 * - Enums become `'a' | 'b'` literal unions.
 * - Optional/required flow from the schema.
 * - Nested objects are inlined; array element types are inlined.
 * - References ($ref) are not followed — emit the last path segment as an
 *   identifier. This keeps output bounded; search has explicit drill-down.
 */

import type { TSchema } from "@sinclair/typebox";

export interface SignatureOptions {
  /** Top-level indent (spaces) for nested fields. Default 2. */
  indent?: number;
  /** Maximum recursion depth to prevent runaway on cyclic schemas. Default 6. */
  maxDepth?: number;
}

export function typeboxToSignature(
  schema: TSchema,
  options: SignatureOptions = {}
): string {
  const indent = options.indent ?? 2;
  const maxDepth = options.maxDepth ?? 6;
  return render(schema, 0, indent, maxDepth);
}

function render(
  schema: unknown,
  depth: number,
  indent: number,
  maxDepth: number
): string {
  if (depth > maxDepth) return "unknown";
  if (!schema || typeof schema !== "object") return "unknown";

  const s = schema as Record<string, unknown>;

  // Literal union via enum
  if (Array.isArray(s.enum)) {
    return (s.enum as unknown[]).map(formatLiteral).join(" | ");
  }

  // Const literal
  if (s.const !== undefined) {
    return formatLiteral(s.const);
  }

  // Union
  if (Array.isArray(s.anyOf)) {
    return (s.anyOf as unknown[])
      .map((v) => render(v, depth + 1, indent, maxDepth))
      .join(" | ");
  }
  if (Array.isArray(s.oneOf)) {
    return (s.oneOf as unknown[])
      .map((v) => render(v, depth + 1, indent, maxDepth))
      .join(" | ");
  }

  // Array
  if (s.type === "array" && s.items) {
    const inner = render(s.items, depth + 1, indent, maxDepth);
    return inner.includes("|") || inner.includes(" ")
      ? `Array<${inner}>`
      : `${inner}[]`;
  }

  // Object
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, unknown>;
    const required = new Set((s.required as string[] | undefined) ?? []);
    const keys = Object.keys(props);
    if (keys.length === 0) return "Record<string, unknown>";

    const pad = " ".repeat(indent * (depth + 1));
    const closingPad = " ".repeat(indent * depth);
    const lines = keys.map((key) => {
      const prop = props[key] as Record<string, unknown> | undefined;
      const optional = required.has(key) ? "" : "?";
      const typeStr = render(prop, depth + 1, indent, maxDepth);
      const description = prop?.description ? ` // ${prop.description}` : "";
      return `${pad}${key}${optional}: ${typeStr};${description}`;
    });
    return `{\n${lines.join("\n")}\n${closingPad}}`;
  }

  // Primitive
  if (s.type === "string") return "string";
  if (s.type === "number" || s.type === "integer") return "number";
  if (s.type === "boolean") return "boolean";
  if (s.type === "null") return "null";

  return "unknown";
}

function formatLiteral(value: unknown): string {
  if (typeof value === "string") {
    // Escape backslashes first, then single quotes — order matters so that the
    // backslashes inserted by the quote escape don't get re-escaped.
    const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `'${escaped}'`;
  }
  if (value === null) return "null";
  return String(value);
}

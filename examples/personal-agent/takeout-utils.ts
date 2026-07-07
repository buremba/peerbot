import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { EventEnvelope } from "@lobu/connector-sdk";

export const DEFAULT_WATERMARK = "1970-01-01T00:00:00.000Z";
export const DEFAULT_BATCH_SIZE = 1000;

export interface LocalTakeoutConfig {
  takeout_dir?: string;
  batch_size?: number;
}

export function assertDirectory(
  config: LocalTakeoutConfig,
  label: string
): string {
  const dir = config.takeout_dir;
  if (!dir) {
    throw new Error(`Missing takeout_dir for ${label}.`);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`${label} takeout directory does not exist: ${dir}`);
  }
  return dir;
}

export function batchSize(config: LocalTakeoutConfig): number {
  return Math.max(1, Math.min(config.batch_size ?? DEFAULT_BATCH_SIZE, 5000));
}

export function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readJsArray<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    return JSON.parse(text.slice(start, end + 1)) as T[];
  } catch {
    return [];
  }
}

export function listFiles(
  root: string,
  predicate: (filePath: string) => boolean
): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.isFile() && predicate(filePath)) {
        out.push(filePath);
      }
    }
  };
  visit(root);
  return out.sort();
}

export function parseDate(input: unknown): Date | undefined {
  if (typeof input !== "string" && typeof input !== "number") return undefined;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function isoDate(input: unknown): string | undefined {
  return parseDate(input)?.toISOString();
}

export function isAfterWatermark(date: Date, watermark?: string): boolean {
  return date.toISOString() > (watermark ?? DEFAULT_WATERMARK);
}

export function takeBatch<T extends EventEnvelope>(
  events: T[],
  watermark: string | undefined,
  max: number
): T[] {
  const after = watermark ?? DEFAULT_WATERMARK;
  return events
    .filter((event) => eventCursor(event) > after)
    .sort((a, b) => eventCursor(a).localeCompare(eventCursor(b)))
    .slice(0, max);
}

export function maxEventCursor(
  events: EventEnvelope[],
  fallback?: string
): string {
  return events.reduce(
    (max, event) => (eventCursor(event) > max ? eventCursor(event) : max),
    fallback ?? DEFAULT_WATERMARK
  );
}

function eventCursor(event: EventEnvelope): string {
  return `${event.occurred_at.toISOString()}\0${event.origin_id}`;
}

export function stableId(
  prefix: string,
  parts: Array<string | number | undefined>
): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${hash}`;
}

export function stripHtml(html: string): string {
  return decodeHtml(htmlToPlainText(html))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlToPlainText(html: string): string {
  let output = "";
  let index = 0;
  const lowerHtml = html.toLowerCase();

  while (index < html.length) {
    const char = html[index];
    if (char !== "<") {
      output += char;
      index += 1;
      continue;
    }

    const tagEnd = html.indexOf(">", index + 1);
    if (tagEnd === -1) {
      output += char;
      index += 1;
      continue;
    }

    const tagName = readTagName(html.slice(index + 1, tagEnd));
    if (tagName === "script" || tagName === "style") {
      const closeTagStart = lowerHtml.indexOf(`</${tagName}`, tagEnd + 1);
      if (closeTagStart === -1) {
        break;
      }
      const closeTagEnd = html.indexOf(">", closeTagStart + tagName.length + 2);
      index = closeTagEnd === -1 ? html.length : closeTagEnd + 1;
      continue;
    }

    if (tagName === "br" || isBlockBreakTag(tagName)) {
      output += "\n";
    }
    index = tagEnd + 1;
  }

  return output;
}

function readTagName(tag: string): string {
  let index = tag[0] === "/" ? 1 : 0;
  while (tag[index] === " " || tag[index] === "\t" || tag[index] === "\n") {
    index += 1;
  }

  let name = "";
  while (index < tag.length) {
    const char = tag[index]?.toLowerCase();
    if (!char || !isAsciiNameChar(char)) {
      break;
    }
    name += char;
    index += 1;
  }
  return name;
}

function isAsciiNameChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-"
  );
}

function isBlockBreakTag(tagName: string): boolean {
  return (
    tagName === "p" ||
    tagName === "div" ||
    tagName === "li" ||
    tagName === "h1" ||
    tagName === "h2" ||
    tagName === "h3" ||
    tagName === "h4" ||
    tagName === "h5" ||
    tagName === "h6"
  );
}

export function decodeHtml(text: string): string {
  return text.replace(
    /&(nbsp|amp|quot|#039|apos|#\d+|#x[0-9a-f]+);/gi,
    (entity, code) => {
      const normalized = String(code).toLowerCase();
      if (normalized === "nbsp") return " ";
      if (normalized === "amp") return "&";
      if (normalized === "quot") return '"';
      if (normalized === "#039" || normalized === "apos") return "'";
      if (normalized.startsWith("#x")) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return decodeHtmlCodePoint(codePoint, entity);
      }
      if (normalized.startsWith("#")) {
        const codePoint = Number(normalized.slice(1));
        return decodeHtmlCodePoint(codePoint, entity);
      }
      return entity;
    }
  );
}

function decodeHtmlCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }
  if (codePoint === 60 || codePoint === 62) {
    return fallback;
  }
  return String.fromCodePoint(codePoint);
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) rows.push(row);

  const headerIndex = rows.findIndex((candidate) => {
    const values = candidate.map((value) => value.trim()).filter(Boolean);
    return values.length > 1 && !values[0]?.startsWith("Notes:");
  });
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex].map((value) => value.trim());
  return rows.slice(headerIndex + 1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = values[index]?.trim() ?? "";
    });
    return record;
  });
}

export function twitterSnowflakeDate(id: string): Date | undefined {
  try {
    const timestamp = Number((BigInt(id) >> 22n) + 1288834974657n);
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? undefined : date;
  } catch {
    return undefined;
  }
}

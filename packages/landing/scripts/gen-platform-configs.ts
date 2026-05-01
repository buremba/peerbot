#!/usr/bin/env bun
/**
 * Extracts platform connection config schemas from the gateway Zod definitions
 * and writes them as a JSON file importable at build time.
 *
 * Run: bun packages/landing/scripts/gen-platform-configs.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const connectionsFile = resolve(
  __dirname,
  "../../server/src/gateway/routes/public/connections.ts"
);

const source = readFileSync(connectionsFile, "utf-8");

interface FieldInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface PlatformConfig {
  platform: string;
  fields: FieldInfo[];
}

interface ConnectionSettings {
  fields: FieldInfo[];
}

function extractSchemas(): {
  platforms: PlatformConfig[];
  connectionSettings: ConnectionSettings;
} {
  const platforms: PlatformConfig[] = [];

  // Match each platform config schema block
  const schemaRegex = /const (\w+ConfigSchema) = z\.object\(\{([\s\S]*?)\}\);/g;
  let match: RegExpExecArray | null = schemaRegex.exec(source);

  while (match !== null) {
    const body = match[2];

    // Extract platform name from the literal
    const platformMatch = body.match(/platform:\s*z\.literal\("(\w+)"\)/);
    if (platformMatch) {
      const platform = platformMatch[1];
      const fields = extractFields(body);
      platforms.push({ platform, fields });
    }

    match = schemaRegex.exec(source);
  }

  // Extract ConnectionSettingsSchema
  const settingsMatch = source.match(
    /const ConnectionSettingsSchema = z\.object\(\{([\s\S]*?)\}\);/
  );
  const connectionSettings: ConnectionSettings = {
    fields: settingsMatch ? extractFields(settingsMatch[1]) : [],
  };

  return { platforms, connectionSettings };
}

function extractFields(body: string): FieldInfo[] {
  const fields: FieldInfo[] = [];

  // Split into individual field chunks by finding top-level field boundaries
  // Fields start with `  fieldName: z` at indentation level
  const fieldChunks = body.split(/\n(?=\s+\w+:\s*z[\s.])/);

  for (const chunk of fieldChunks) {
    // Extract field name
    const nameMatch = chunk.match(/^\s*(\w+):\s*z/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (name === "platform") continue; // Skip the discriminator

    // Must have .openapi({ description: "..." })
    const descMatch = chunk.match(
      /\.openapi\(\{\s*description:\s*\n?\s*"([^"]*(?:\\.[^"]*)*)"/
    );
    if (!descMatch) continue;
    const description = descMatch[1].replace(/\\"/g, '"');

    const required = !chunk.includes(".optional()");
    const type = inferType(chunk);

    fields.push({ name, type, required, description });
  }

  return fields;
}

function inferType(chunk: string): string {
  if (chunk.includes("z.array(")) return "string[]";
  if (chunk.includes("z.boolean()") || chunk.includes(".boolean()"))
    return "boolean";
  const enumMatch = chunk.match(/\.enum\(\[([^\]]+)\]/);
  if (enumMatch) {
    return enumMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/"/g, ""))
      .join(" | ");
  }
  return "string";
}

const result = extractSchemas();
const outPath = resolve(__dirname, "../src/generated/platform-configs.json");

writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Wrote ${result.platforms.length} platform configs to ${outPath}`);

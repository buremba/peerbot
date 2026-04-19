import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function loadEnvFile(envFile: string, configPath: string | null) {
  const base = configPath ? dirname(configPath) : process.cwd();
  const fullPath = resolve(base, envFile);
  if (!existsSync(fullPath)) return;

  const content = readFileSync(fullPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

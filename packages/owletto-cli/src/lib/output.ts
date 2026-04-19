import type { ResolvedProfile } from './config.ts';

let jsonMode = false;
let quietMode = false;

export function setOutputMode(opts: { json?: boolean; quiet?: boolean }) {
  if (opts.json) jsonMode = true;
  if (opts.quiet) quietMode = true;
}

export function isJson() {
  return jsonMode;
}

export function printContextHeader(profileName: string, description: string) {
  if (jsonMode || quietMode) return;
  process.stderr.write(`[${profileName}] ${description}\n`);
}

export function printJson(data: unknown, profile?: ResolvedProfile) {
  const output = profile ? { context: profile.name, ...(data as Record<string, unknown>) } : data;
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

export function printText(text: string) {
  if (quietMode) return;
  process.stdout.write(text + '\n');
}

export function printError(message: string) {
  process.stderr.write(`error: ${message}\n`);
}

export function printTable(headers: string[], rows: string[][]) {
  if (jsonMode || quietMode) return;
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  process.stdout.write(line(headers) + '\n');
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
  for (const row of rows) {
    process.stdout.write(line(row) + '\n');
  }
}

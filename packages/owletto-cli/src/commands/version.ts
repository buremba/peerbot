import { defineCommand } from 'citty';
import { isJson, printJson, printText } from '../lib/output.ts';

declare const __CLI_VERSION__: string;

async function getVersion(): Promise<string> {
  if (typeof __CLI_VERSION__ !== 'undefined') return __CLI_VERSION__;
  // Dev mode fallback: read from package.json
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(resolve(dir, '../../package.json'), 'utf-8'));
  return pkg.version;
}

export default defineCommand({
  meta: {
    name: 'version',
    description: 'Print the CLI version',
  },
  async run() {
    const version = await getVersion();
    if (isJson()) {
      printJson({ version });
    } else {
      printText(`owletto ${version}`);
    }
  },
});

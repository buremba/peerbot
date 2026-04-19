import { readFileSync, writeFileSync } from 'fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

export default defineConfig({
  entry: ['src/bin.ts', 'src/lib/schema.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  splitting: true,
  clean: true,
  external: ['@lobu/owletto-sdk', '@lobu/owletto-worker', 'playwright'],
  noExternal: ['citty', '@clack/prompts'],
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
  async onSuccess() {
    // Add shebang only to the entry point (not code-split chunks)
    const file = 'dist/bin.js';
    const content = readFileSync(file, 'utf8');
    if (!content.startsWith('#!')) {
      writeFileSync(file, '#!/usr/bin/env node\n' + content);
    }
  },
});

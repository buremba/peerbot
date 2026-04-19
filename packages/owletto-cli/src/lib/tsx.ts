import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export function getTsxInvocation(args: string[]): { cmd: string; args: string[] } {
  const tsxPackageJson = require.resolve('tsx/package.json');
  const cliPath = join(dirname(tsxPackageJson), 'dist', 'cli.mjs');
  return {
    cmd: process.execPath,
    args: [cliPath, ...args],
  };
}

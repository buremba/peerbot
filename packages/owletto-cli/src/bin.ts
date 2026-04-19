#!/usr/bin/env node
import { runMain } from 'citty';
import { parseGlobalFlags } from './globals.ts';
import { CliError } from './lib/errors.ts';
import { printError } from './lib/output.ts';
import { main } from './main.ts';

// Parse global flags before citty sees process.argv
parseGlobalFlags();

runMain(main).catch((err: unknown) => {
  if (err instanceof CliError) {
    printError(err.message);
    process.exit(err.exitCode);
  }
  throw err;
});

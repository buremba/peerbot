/**
 * Options shared by every cloud subcommand registered through
 * `withCommonOpts` — one shape, not a per-command-group copy.
 */
export interface CloudCommandOptions {
  context?: string;
  org?: string;
  json?: boolean;
}

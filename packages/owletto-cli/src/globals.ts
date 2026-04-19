import { type ResolvedProfile, resolveProfile } from './lib/config.ts';
import { readActiveContext } from './lib/context.ts';
import { loadEnvFile } from './lib/env-loader.ts';
import { setOutputMode } from './lib/output.ts';

export interface GlobalFlags {
  profile?: string;
  json: boolean;
  quiet: boolean;
}

let _flags: GlobalFlags | undefined;
let _profile: ResolvedProfile | undefined;

export function parseGlobalFlags(): GlobalFlags {
  const args = process.argv.slice(2);
  const flags: GlobalFlags = { json: false, quiet: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && args[i + 1]) {
      flags.profile = args[i + 1];
      args.splice(i, 2);
      i--;
    } else if (args[i] === '--json') {
      flags.json = true;
      args.splice(i, 1);
      i--;
    } else if (args[i] === '--quiet' || args[i] === '-q') {
      flags.quiet = true;
      args.splice(i, 1);
      i--;
    }
  }

  process.argv = [...process.argv.slice(0, 2), ...args];
  setOutputMode({ json: flags.json, quiet: flags.quiet });
  _flags = flags;
  return flags;
}

export function getProfile(): ResolvedProfile {
  if (_profile) return _profile;

  const flags = _flags || { json: false, quiet: false };
  const contextName = readActiveContext();
  _profile = resolveProfile(flags.profile, contextName);

  if (_profile.config.envFile) {
    loadEnvFile(_profile.config.envFile, _profile.configPath);
  }

  return _profile;
}

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { findConfigFile } from './config.ts';

function globalContextDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || resolve(homedir(), '.config');
  return resolve(base, 'owletto');
}

function globalContextFile(): string {
  return resolve(globalContextDir(), 'active-context');
}

function projectContextDir(): string | null {
  const configPath = findConfigFile();
  if (!configPath) return null;
  return resolve(dirname(configPath), '.owletto');
}

function projectContextFile(): string | null {
  const dir = projectContextDir();
  return dir ? resolve(dir, 'context') : null;
}

export function readActiveContext(): string | null {
  // Project-local context takes priority
  const projectFile = projectContextFile();
  if (projectFile && existsSync(projectFile)) {
    return readFileSync(projectFile, 'utf-8').trim() || null;
  }

  // Fall back to global context
  const globalFile = globalContextFile();
  if (existsSync(globalFile)) {
    return readFileSync(globalFile, 'utf-8').trim() || null;
  }

  return null;
}

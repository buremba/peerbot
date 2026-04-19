import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findConfigFile } from './config.ts';

function globalContextDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || resolve(process.env.HOME || '~', '.config');
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

export function writeActiveContext(name: string, scope: 'project' | 'global' = 'project') {
  if (scope === 'project') {
    const dir = projectContextDir();
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'context'), name + '\n');
      return;
    }
    // Fall through to global if no project config found
  }

  const dir = globalContextDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(globalContextFile(), name + '\n');
}

export function deleteActiveContext(scope: 'project' | 'global' | 'both' = 'both') {
  if (scope === 'project' || scope === 'both') {
    const projectFile = projectContextFile();
    if (projectFile && existsSync(projectFile)) {
      unlinkSync(projectFile);
    }
  }
  if (scope === 'global' || scope === 'both') {
    const globalFile = globalContextFile();
    if (existsSync(globalFile)) {
      unlinkSync(globalFile);
    }
  }
}

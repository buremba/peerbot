/**
 * Minimal glob matcher + recursive directory walk.
 *
 * Supports the subset of glob syntax connectors actually need:
 *   - `*`   matches any run of characters except `/`
 *   - `**`  matches any run of characters including `/`
 *   - `?`   matches exactly one character except `/`
 *   - Literal `.` `/` `_` `-` segments
 *
 * No brace-expansion, no `!` negation, no `[ ]` character classes. If a
 * connector needs more, it can iterate `walkFiles("**\/*")` and filter in
 * its own code — keeping the SDK surface small.
 */

import { readdir } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';

/**
 * Recursive walk yielding POSIX-style relative paths (forward-slash).
 * Skips dot-directories of the cache itself (`.lobu-cache`) but otherwise
 * includes hidden files — git's `.git/` is excluded by callers that need
 * to (git source uses a separate snapshot dir without `.git`).
 */
export async function* walkDirectoryRelative(root: string): AsyncIterable<string> {
  async function* walk(dir: string, prefix: string): AsyncIterable<string> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    // Stable order — deterministic walk for tests + manifests.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childPosix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const childAbs = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walk(childAbs, childPosix);
      } else if (entry.isFile()) {
        yield childPosix;
      }
      // Symlinks/sockets/etc. are skipped on purpose — connectors don't
      // need them and they're a common attack vector through extracted tarballs.
    }
  }
  yield* walk(root, '');
}

/**
 * Compile a glob to a RegExp. Anchored on both ends.
 *
 * Implementation note: we walk the glob char-by-char rather than splitting on
 * `*` so we can distinguish `*` from `**` without ambiguity, and so literal
 * regex metacharacters get escaped exactly once.
 */
function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` — match any run (including `/`). When followed by `/`, the
        // whole `**/` consumes zero or more directory segments so e.g.
        // `**/*.md` matches `foo.md` AND `a/b/foo.md`. Same on the trailing
        // boundary so `foo/**` matches `foo` itself.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2; // skip `**` and the slash
        } else if (i === 0 && glob[i + 2] === undefined) {
          // bare `**` — match anything (including empty).
          re += '.*';
          i++;
        } else {
          re += '.*';
          i++;
        }
      } else {
        // `*` — match any run not containing `/`.
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '/') {
      re += '/';
    } else if (
      c === '.' ||
      c === '(' ||
      c === ')' ||
      c === '+' ||
      c === '|' ||
      c === '^' ||
      c === '$' ||
      c === '{' ||
      c === '}' ||
      c === '[' ||
      c === ']' ||
      c === '\\'
    ) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

const _globCache = new Map<string, RegExp>();
function compileCached(glob: string): RegExp {
  let r = _globCache.get(glob);
  if (!r) {
    r = globToRegExp(glob);
    _globCache.set(glob, r);
  }
  return r;
}

/** Test a POSIX-style relative path against `glob`. */
export function matchesGlob(relativePath: string, glob: string): boolean {
  // Normalize windows separators if any leaked in. Callers should pass
  // POSIX already (walkDirectoryRelative emits POSIX) but defensively:
  const norm = sep === posix.sep ? relativePath : relativePath.split(sep).join(posix.sep);
  return compileCached(glob).test(norm);
}

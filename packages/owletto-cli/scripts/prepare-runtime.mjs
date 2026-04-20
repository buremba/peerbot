import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, '..');
const repoRoot = resolve(packageDir, '../..');
const runtimeDir = join(packageDir, 'runtime');

const cliPackageJsonPath = join(packageDir, 'package.json');
const backendSrcDir = join(repoRoot, 'packages', 'owletto-backend', 'src');
const migrationsDir = join(repoRoot, 'db', 'migrations');
const embeddingsSrcDir = join(repoRoot, 'packages', 'owletto-embeddings', 'src');
const webPackageDir = join(repoRoot, 'packages', 'owletto-web');
const workerSrcDir = join(repoRoot, 'packages', 'owletto-worker', 'src');
const connectorsSrcDir = join(repoRoot, 'packages', 'owletto-connectors', 'src');

const IGNORED_NAMES = new Set(['.DS_Store', '__tests__']);
const TEXT_PATCHES = [
  {
    relativePath: 'src/lib/feed-sync.ts',
    oldText: '../../../owletto-worker/src/executor/runtime',
    newText: '../../packages/owletto-worker/src/executor/runtime',
  },
  {
    relativePath: 'src/tools/admin/manage_operations.ts',
    oldText: '../../../../owletto-worker/src/executor/runtime',
    newText: '../../../packages/owletto-worker/src/executor/runtime',
  },
];

function ensureWebDist() {
  const webDistIndex = join(webPackageDir, 'dist', 'index.html');
  if (existsSync(webDistIndex)) {
    return;
  }

  execFileSync('bun', ['run', 'build'], {
    cwd: webPackageDir,
    stdio: 'inherit',
  });
}

function copyTree(sourcePath, targetPath) {
  if (IGNORED_NAMES.has(basename(sourcePath))) {
    return;
  }

  const sourceStat = statSync(sourcePath);
  if (sourceStat.isDirectory()) {
    mkdirSync(targetPath, { recursive: true });
    for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
      copyTree(join(sourcePath, entry.name), join(targetPath, entry.name));
    }
    return;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath);
}

function patchTextFile(relativePath, oldText, newText) {
  const absolutePath = join(runtimeDir, relativePath);
  const original = readFileSync(absolutePath, 'utf8');
  if (!original.includes(oldText)) {
    throw new Error(`Expected to find ${oldText} in ${absolutePath}`);
  }
  writeFileSync(absolutePath, original.replace(oldText, newText));
}

function writeRuntimePackageJson() {
  const cliPackageJson = JSON.parse(readFileSync(cliPackageJsonPath, 'utf8'));
  writeFileSync(
    join(runtimeDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'owletto-runtime',
        private: true,
        type: 'module',
        version: cliPackageJson.version,
      },
      null,
      2
    )}\n`
  );
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });
ensureWebDist();

copyTree(backendSrcDir, join(runtimeDir, 'src'));
copyTree(migrationsDir, join(runtimeDir, 'db', 'migrations'));
copyTree(embeddingsSrcDir, join(runtimeDir, 'packages', 'owletto-embeddings', 'src'));
copyTree(join(webPackageDir, 'dist'), join(runtimeDir, 'packages', 'owletto-web', 'dist'));
copyTree(join(webPackageDir, 'index.html'), join(runtimeDir, 'packages', 'owletto-web', 'index.html'));
copyTree(workerSrcDir, join(runtimeDir, 'packages', 'owletto-worker', 'src'));
copyTree(connectorsSrcDir, join(runtimeDir, 'connectors'));
writeRuntimePackageJson();

for (const patch of TEXT_PATCHES) {
  patchTextFile(patch.relativePath, patch.oldText, patch.newText);
}

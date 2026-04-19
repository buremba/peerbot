import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, '..');
const repoRoot = resolve(packageDir, '../..');
const runtimeDir = join(packageDir, 'runtime');

const requireFromRepo = createRequire(join(repoRoot, 'package.json'));

function ensureWebDist() {
  const webDistIndex = join(repoRoot, 'packages', 'web', 'dist', 'index.html');
  if (existsSync(webDistIndex)) {
    return;
  }

  const vitePackageJson = requireFromRepo.resolve('vite/package.json');
  const viteCli = join(dirname(vitePackageJson), 'bin', 'vite.js');
  execFileSync(process.execPath, [viteCli, 'build'], {
    cwd: join(repoRoot, 'packages', 'web'),
    stdio: 'inherit',
  });
}

function copyIntoRuntime(sourceRelativePath, targetRelativePath = sourceRelativePath) {
  const sourcePath = join(repoRoot, sourceRelativePath);
  const targetPath = join(runtimeDir, targetRelativePath);
  mkdirSync(dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath, statSync(sourcePath).isDirectory() ? { recursive: true } : {});
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });

ensureWebDist();

copyIntoRuntime('src');
copyIntoRuntime('db/migrations');
copyIntoRuntime('packages/embeddings-service/src');
copyIntoRuntime('packages/web/dist');
copyIntoRuntime('packages/web/index.html');
copyIntoRuntime('packages/worker/src');

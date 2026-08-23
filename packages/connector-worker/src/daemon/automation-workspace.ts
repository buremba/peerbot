import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';

const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export interface AutomationWorkspaceOptions {
  root?: string;
  signal?: AbortSignal;
  gitTimeoutMs?: number;
  cloneRepository?: (
    repository: string,
    destination: string,
    execution: Pick<AutomationWorkspaceOptions, 'signal' | 'gitTimeoutMs'>
  ) => Promise<void>;
  readOriginRepository?: (
    workspace: string,
    execution: Pick<AutomationWorkspaceOptions, 'signal' | 'gitTimeoutMs'>
  ) => Promise<string>;
}

export function defaultAutomationWorkspaceRoot(): string {
  return path.join(homedir(), 'lobu-workspaces');
}

export function runGitCommand(
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    binary?: string;
  } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GCM_INTERACTIVE: 'Never',
      GIT_TERMINAL_PROMPT: '0',
      SSH_ASKPASS_REQUIRE: 'never',
    };
    delete env.WORKER_API_TOKEN;
    execFile(
      options.binary ?? 'git',
      args,
      {
        cwd: options.cwd,
        env,
        maxBuffer: 1024 * 1024,
        signal: options.signal,
        timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`git ${args[0] ?? 'command'} failed: ${detail}`, { cause: error }));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function cloneGitHubRepository(
  repository: string,
  destination: string,
  execution: Pick<AutomationWorkspaceOptions, 'signal' | 'gitTimeoutMs'>
): Promise<void> {
  await runGitCommand(['clone', '--', `https://github.com/${repository}.git`, destination], {
    signal: execution.signal,
    timeoutMs: execution.gitTimeoutMs,
  });
}

function repositoryFromOrigin(origin: string): string | null {
  const trimmed = origin.trim().replace(/\/$/, '').replace(/\.git$/, '');
  const https = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (https) return https[1];
  const ssh = trimmed.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+\/[^/]+)$/i);
  return ssh?.[1] ?? null;
}

async function readGitHubOriginRepository(
  workspace: string,
  execution: Pick<AutomationWorkspaceOptions, 'signal' | 'gitTimeoutMs'>
): Promise<string> {
  const origin = await runGitCommand(['remote', 'get-url', 'origin'], {
    cwd: workspace,
    signal: execution.signal,
    timeoutMs: execution.gitTimeoutMs,
  });
  const repository = repositoryFromOrigin(origin);
  if (!repository) {
    throw new Error(`task workspace '${workspace}' has a non-GitHub origin`);
  }
  return repository;
}

function ensureOwnedDirectory(root: string, target: string): void {
  const resolvedRoot = realpathSync(root);
  const resolvedTarget = realpathSync(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`automation workspace '${target}' escapes configured root '${root}'`);
  }
  if (lstatSync(target).isSymbolicLink()) {
    throw new Error(`automation workspace '${target}' must not be a symbolic link`);
  }
}

async function prepareTaskCheckout(
  root: string,
  entity: NonNullable<PollResponse['entity']>,
  options: AutomationWorkspaceOptions
): Promise<string> {
  const repository = entity.metadata.repository;
  if (typeof repository !== 'string' || !GITHUB_REPOSITORY.test(repository)) {
    throw new Error(
      `engineering task ${entity.id} requires metadata.repository in 'owner/repository' form`
    );
  }

  const workspace = path.join(root, `task-${entity.id}`);
  const cloneRepository = options.cloneRepository ?? cloneGitHubRepository;
  const readOriginRepository = options.readOriginRepository ?? readGitHubOriginRepository;
  const execution = { signal: options.signal, gitTimeoutMs: options.gitTimeoutMs };
  if (!existsSync(workspace)) {
    const stagingRoot = mkdtempSync(path.join(root, `.task-${entity.id}-`));
    const stagingCheckout = path.join(stagingRoot, 'checkout');
    try {
      await cloneRepository(repository, stagingCheckout, execution);
      if (!existsSync(path.join(stagingCheckout, '.git'))) {
        throw new Error(`clone for ${repository} did not create a Git checkout`);
      }
      renameSync(stagingCheckout, workspace);
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  ensureOwnedDirectory(root, workspace);
  if (!existsSync(path.join(workspace, '.git'))) {
    throw new Error(`task workspace '${workspace}' is not a Git checkout`);
  }
  const actualRepository = await readOriginRepository(workspace, execution);
  if (actualRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `task workspace '${workspace}' belongs to ${actualRepository}, expected ${repository}`
    );
  }
  return workspace;
}

/**
 * Resolve the only directory in which a device Automation may execute.
 * Engineering tasks retain a stable checkout across sequential runs; every
 * other Automation is isolated by globally unique run id. There is deliberately
 * no fallback to the daemon's launch directory.
 */
export async function prepareAutomationWorkspace(
  job: PollResponse,
  options: AutomationWorkspaceOptions = {}
): Promise<string> {
  const runId = job.run_id;
  if (runId == null || !Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error('automation workspace requires a positive run_id');
  }

  const root = path.resolve(options.root ?? defaultAutomationWorkspaceRoot());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (job.entity?.entity_type === 'engineering-task') {
    return prepareTaskCheckout(root, job.entity, options);
  }

  const workspace = path.join(root, `run-${runId}`);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  ensureOwnedDirectory(root, workspace);
  return workspace;
}

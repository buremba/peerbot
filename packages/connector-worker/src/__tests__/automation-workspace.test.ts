import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';
import {
  prepareAutomationWorkspace,
  runGitCommand,
} from '../daemon/automation-workspace.js';

function job(entity?: PollResponse['entity']): PollResponse {
  return {
    run_id: 1119450,
    run_type: 'automation',
    ...(entity ? { entity, entity_ids: [entity.id] } : {}),
  };
}

describe('Automation workspace isolation', () => {
  test('Git execution is non-interactive and does not inherit the worker token', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lobu-git-environment-'));
    const script = path.join(root, 'inspect-git-env.mjs');
    writeFileSync(
      script,
      `console.log(JSON.stringify({
        terminalPrompt: process.env.GIT_TERMINAL_PROMPT,
        credentialInteractive: process.env.GCM_INTERACTIVE,
        askpass: process.env.SSH_ASKPASS_REQUIRE,
        workerToken: process.env.WORKER_API_TOKEN ?? null,
      }));\n`
    );
    const priorToken = process.env.WORKER_API_TOKEN;
    process.env.WORKER_API_TOKEN = 'must-not-cross-the-process-boundary';
    try {
      const output = await runGitCommand([script], {
        binary: process.execPath,
        timeoutMs: 5_000,
      });
      expect(JSON.parse(output)).toEqual({
        terminalPrompt: '0',
        credentialInteractive: 'Never',
        askpass: 'never',
        workerToken: null,
      });
    } finally {
      if (priorToken === undefined) delete process.env.WORKER_API_TOKEN;
      else process.env.WORKER_API_TOKEN = priorToken;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Git execution is bounded and cancellable', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lobu-git-timeout-'));
    const script = path.join(root, 'hang.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1_000);\n');
    try {
      await expect(
        runGitCommand([script], { binary: process.execPath, timeoutMs: 50 })
      ).rejects.toThrow('git');

      const controller = new AbortController();
      const cancelled = runGitCommand([script], {
        binary: process.execPath,
        signal: controller.signal,
        timeoutMs: 5_000,
      });
      controller.abort();
      await expect(cancelled).rejects.toThrow('git');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('provisions one stable checkout per engineering task', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lobu-task-workspace-'));
    const cloned: Array<{ repository: string; destination: string }> = [];
    try {
      const task = job({
        id: 35364,
        name: 'Dogfood task isolation test',
        entity_type: 'engineering-task',
        metadata: { repository: 'lobu-ai/lobu' },
      });
      const workspace = await prepareAutomationWorkspace(task, {
        root,
        cloneRepository: async (repository, destination) => {
          cloned.push({ repository, destination });
          mkdirSync(path.join(destination, '.git'), { recursive: true });
        },
        readOriginRepository: async () => 'lobu-ai/lobu',
      });

      expect(workspace).toBe(path.join(root, 'task-35364'));
      expect(existsSync(workspace)).toBe(true);
      expect(cloned).toHaveLength(1);
      expect(cloned[0]?.repository).toBe('lobu-ai/lobu');
      expect(cloned[0]?.destination).toContain(path.join(root, '.task-35364-'));

      const resumed = await prepareAutomationWorkspace(task, {
        root,
        cloneRepository: async () => {
          throw new Error('must not clone an existing task checkout');
        },
        readOriginRepository: async () => 'lobu-ai/lobu',
      });
      expect(resumed).toBe(workspace);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a task workspace whose origin belongs to another repository', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lobu-task-workspace-'));
    try {
      const workspace = path.join(root, 'task-35364');
      mkdirSync(path.join(workspace, '.git'), { recursive: true });
      await expect(
        prepareAutomationWorkspace(
          job({
            id: 35364,
            name: 'Dogfood task isolation test',
            entity_type: 'engineering-task',
            metadata: { repository: 'lobu-ai/lobu' },
          }),
          {
            root,
            readOriginRepository: async () => 'someone-else/repository',
          }
        )
      ).rejects.toThrow('belongs to someone-else/repository');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses an isolated run directory for non-task Automations', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lobu-run-workspace-'));
    try {
      const workspace = await prepareAutomationWorkspace(job(), { root });
      expect(workspace).toBe(path.join(root, 'run-1119450'));
      expect(workspace).not.toBe(process.cwd());
      expect(existsSync(workspace)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when an engineering task has no repository', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lobu-task-workspace-'));
    try {
      await expect(
        prepareAutomationWorkspace(
          job({
            id: 35364,
            name: 'Dogfood task isolation test',
            entity_type: 'engineering-task',
            metadata: {},
          }),
          { root }
        )
      ).rejects.toThrow("requires metadata.repository in 'owner/repository' form");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

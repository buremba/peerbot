import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';
import { prepareAutomationWorkspace } from '../daemon/automation-workspace.js';

function job(entity?: PollResponse['entity']): PollResponse {
  return {
    run_id: 1119450,
    run_type: 'automation',
    ...(entity ? { entity, entity_ids: [entity.id] } : {}),
  };
}

describe('Automation workspace isolation', () => {
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

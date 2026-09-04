import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  printSelfCheckResult,
  probeIsolateLane,
  runConnectorRuntimeSelfCheck,
  type SelfCheckResult,
} from '../self-check/index.js';

// One tiny connector so the full self-check exercises discovery + compile
// without walking every bundled connector. No native deps: the isolate section
// is what this suite pins, not the compiler's own dependency graph.
const MINIMAL_CONNECTOR = `
import { ConnectorRuntime } from '@lobu/connector-sdk';

export default class SelfCheckTestConnector extends ConnectorRuntime {
  definition = {
    key: 'self_check_test',
    name: 'Self-Check Test',
    description: 'Fixture connector for the self-check isolate_lane test.',
    version: '0.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
  };
}
`;

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

const BASE_RESULT: Omit<SelfCheckResult, 'isolate_lane'> = {
  ok: true,
  surface: 'worker',
  connectorSourceDir: null,
  connectorCount: 0,
  checks: [],
};

describe('self-check isolate_lane', () => {
  it('probeIsolateLane reports the lane unavailable under Bun and names the runtime', async () => {
    // bun:test always runs on Bun, which cannot dlopen the isolated-vm addon.
    expect(typeof process.versions.bun).toBe('string');
    const lane = await probeIsolateLane();
    expect(lane.available).toBe(false);
    expect(lane.reason).toMatch(/Bun/);
    expect(lane.node_version).toBe(process.versions.node);
    // Bun selects no build, so there is no package version to report.
    expect(lane.isolated_vm_version).toBeNull();
  });

  it(
    'runConnectorRuntimeSelfCheck carries the section without letting it decide ok',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'lobu-self-check-isolate-test-'));
      try {
        await writeFile(join(dir, 'self-check-test.ts'), MINIMAL_CONNECTOR, 'utf-8');
        const result = await runConnectorRuntimeSelfCheck({
          surface: 'worker',
          connectorSourceCandidates: [dir],
        });
        expect(result.isolate_lane).toEqual({
          available: false,
          reason: expect.stringMatching(/Bun/),
          isolated_vm_version: null,
          node_version: process.versions.node,
        });
        // The lane is informational: no check entry carries it, and `ok` is
        // still exactly the AND of the recorded checks.
        expect(result.checks.some((c) => /isolate/i.test(c.name))).toBe(false);
        expect(result.ok).toBe(result.checks.every((c) => c.ok));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000
  );

  it('printSelfCheckResult prints one isolate-lane line for either state', () => {
    const available = captureStderr(() =>
      printSelfCheckResult({
        ...BASE_RESULT,
        isolate_lane: {
          available: true,
          reason: null,
          isolated_vm_version: '6.1.2',
          node_version: '22.0.0',
        },
      })
    );
    expect(available).toContain('isolate lane: available (isolated-vm 6.1.2, Node 22.0.0)');

    const unavailable = captureStderr(() =>
      printSelfCheckResult({
        ...BASE_RESULT,
        isolate_lane: {
          available: false,
          reason: 'no build for this line',
          isolated_vm_version: null,
          node_version: '25.0.0',
        },
      })
    );
    expect(unavailable).toContain('isolate lane: unavailable on Node 25.0.0 — no build for this line');
  });
});

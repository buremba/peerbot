import { describe, expect, test } from 'bun:test';
import {
  MAC_DEVICE_DAEMON_PROTOCOL,
  macDeviceDaemonMetadata,
  validateMacDeviceDaemonOptions,
} from '../daemon/mac-device-daemon';
import { WorkerPollLoop } from '../daemon/poll-loop';

describe('Mac device daemon options', () => {
  test('emits versioned protocol metadata', () => {
    expect(macDeviceDaemonMetadata('15.8.0')).toMatchObject({
      name: 'lobu-device-daemon',
      version: '15.8.0',
      protocol: MAC_DEVICE_DAEMON_PROTOCOL,
      platform: 'macos',
      artifact: 'standalone-bun-macho-arm64',
    });
  });

  test('allows no-poll metadata mode without credentials', () => {
    expect(
      validateMacDeviceDaemonOptions({ version: '15.8.0', noPoll: true })
    ).toMatchObject({ noPoll: true, apiUrl: '', workerApiToken: '' });
  });

  test('requires an absolute HTTP URL and durable PAT for polling', () => {
    expect(() =>
      validateMacDeviceDaemonOptions({ version: '15.8.0' })
    ).toThrow('--api-url or API_URL is required');
    expect(() =>
      validateMacDeviceDaemonOptions({
        version: '15.8.0',
        apiUrl: 'file:///tmp/api',
        workerApiToken: 'owl_pat_test',
      })
    ).toThrow('expected an http(s) URL');
    expect(() =>
      validateMacDeviceDaemonOptions({
        version: '15.8.0',
        apiUrl: 'https://example.test',
        workerApiToken: 'session-token',
      })
    ).toThrow('owl_pat_');
  });

  test('rejects malformed identity and concurrency settings', () => {
    const base = {
      version: '15.8.0',
      apiUrl: 'https://example.test',
      workerApiToken: 'owl_pat_test',
    };
    expect(() => validateMacDeviceDaemonOptions({ ...base, workerId: 'bad id' })).toThrow(
      'invalid --worker-id'
    );
    expect(() =>
      validateMacDeviceDaemonOptions({ ...base, maxConcurrentJobs: 0 })
    ).toThrow('--max-concurrent-jobs');
    expect(() =>
      validateMacDeviceDaemonOptions({ ...base, defaultAgentKind: 'not-an-agent' as never })
    ).toThrow('--default-agent-kind');
  });
});

describe('WorkerPollLoop', () => {
  test('stops polling and waits for the active job during shutdown', async () => {
    let polls = 0;
    let release!: () => void;
    const jobFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      healthCheck: async () => true,
      poll: async () => {
        polls++;
        return { run_id: 1, run_type: 'automation' } as never;
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      pollIntervalMs: 1,
      maxConcurrentJobs: 1,
      execute: async () => jobFinished,
    });

    const started = loop.start();
    await Bun.sleep(10);
    expect(polls).toBe(1);
    loop.stop();
    release();
    expect(await loop.waitForActiveJobs(1000, 1)).toBe(true);
    await started;
  });
});

import { describe, expect, it } from 'vitest';
import { runWithAbortDeadline } from '../../src/index.js';

describe('runWithAbortDeadline', () => {
  it('returns the work result when it finishes before the deadline', async () => {
    const result = await runWithAbortDeadline(async () => 'ok', 1_000, 'TIMEOUT');
    expect(result).toBe('ok');
  });

  it('returns the sentinel and aborts the signal when work hangs past the deadline', async () => {
    let abortedDuringWork = false;
    const result = await runWithAbortDeadline<string>(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            abortedDuringWork = true;
            resolve('late'); // ignored — the deadline already won the race
          });
        }),
      30,
      'TIMEOUT'
    );
    expect(result).toBe('TIMEOUT');
    expect(abortedDuringWork).toBe(true);
  });

  it('swallows a rejection from work and returns the sentinel', async () => {
    const result = await runWithAbortDeadline(async () => {
      throw new Error('boom');
    }, 1_000, 'FALLBACK');
    expect(result).toBe('FALLBACK');
  });
});

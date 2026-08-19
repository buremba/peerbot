import { describe, expect, spyOn, test } from 'bun:test';
import { log, setDebug } from '../daemon/log.js';

describe('daemon log', () => {
  test('info always prints; debug prints only after setDebug(true)', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDebug(false);
      log.info('run line');
      log.debug('poll chatter');
      expect(err).toHaveBeenCalledTimes(1);

      setDebug(true);
      log.debug('poll chatter');
      expect(err).toHaveBeenCalledTimes(2);
    } finally {
      setDebug(false);
      err.mockRestore();
    }
  });
});

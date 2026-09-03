import { describe, expect, it } from 'bun:test';
import { connect } from '../net.js';

describe('WinterCG Direct Sockets (connect)', () => {
  it('throws a descriptive error when connect() is invoked outside an isolate network runtime', () => {
    expect(() => connect('db.example.com:5432')).toThrow(
      /WinterCG connect\(\) is not available in this execution environment/
    );
  });

  it('delegates to globalThis.connect when available', () => {
    const mockSocket = {
      readable: {} as any,
      writable: {} as any,
      closed: Promise.resolve(),
      close: async () => {},
      startTls: () => mockSocket,
    };
    (globalThis as any).connect = (addr: any, opts: any) => {
      expect(addr).toEqual({ hostname: 'db.example.com', port: 5432 });
      expect(opts?.secureTransport).toBe('on');
      return mockSocket;
    };
    try {
      const socket = connect({ hostname: 'db.example.com', port: 5432 }, { secureTransport: 'on' });
      expect(socket).toBe(mockSocket);
    } finally {
      delete (globalThis as any).connect;
    }
  });
});

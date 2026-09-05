import { type AddressInfo, createServer, type Server } from "node:net";
import { createIsolateConnectorCompiler } from "@lobu/connector-worker/compile";
import { IsolateExecutor } from "@lobu/connector-worker/executor/isolate";
import { loadIsolatedVm } from "@lobu/connector-worker/isolate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A connector whose `query` opens one host-dialled socket to the hostname in
 * config, sends a line and returns the echo. `connect()` is the WinterCG
 * primitive the prelude installs; the HOST resolves the name and dials.
 */
const ECHO_CLIENT_CONNECTOR = `
import { ConnectorRuntime } from '@lobu/connector-sdk';

export default class EchoClient extends ConnectorRuntime {
  definition = {
    key: 'echo_client',
    name: 'Echo client',
    version: '1.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
  };

  async query(ctx) {
    const socket = globalThis.connect(ctx.config.ECHO_HOST + ':' + ctx.config.ECHO_PORT);
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode('ping\\n'));
    const reader = socket.readable.getReader();
    let text = '';
    while (!text.includes('\\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await socket.close();
    return { rows: [{ reply: text.trim() }] };
  }
}
`;

describe("socketOpen dials every validated address in resolver order", () => {
	let server: Server;
	let port: number;
	let code: string;

	beforeAll(async () => {
		if (!(await loadIsolatedVm())) {
			throw new Error(`isolated-vm must load under Node ${process.versions.node} for the isolate lane suite`);
		}
		server = createServer((sock) => {
			sock.on("data", (chunk) => sock.write(`echo:${chunk.toString().trim()}\n`));
		});
		// IPv4 loopback ONLY, so `::1` refuses and `127.0.0.1` answers.
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as AddressInfo).port;
		code = await createIsolateConnectorCompiler().compileConnectorForIsolateFromSource(ECHO_CLIENT_CONNECTOR);
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	const job = (host: string) => ({
		mode: "query" as const,
		query: "ping",
		config: { ECHO_HOST: host, ECHO_PORT: String(port) },
		checkpoint: null,
		credentials: null,
		sessionState: null,
		env: { LOBU_DB_EGRESS_POLICY: "allow-private" },
	});

	it("falls back to the next resolved address when the first refuses", async () => {
		// Staged dual-stack answer: the AAAA record first (nothing listens on
		// ::1), then the A record that does. Node's own `net.connect(hostname)`
		// recovers through autoSelectFamily; the host dialler must too.
		const executor = new IsolateExecutor({
			timeoutMs: 20_000,
			lookup: async () => [{ address: "::1" }, { address: "127.0.0.1" }],
		});
		const result = (await executor.execute(code, job("db.dual-stack.test"))) as {
			rows: Array<{ reply: string }>;
		};
		expect(result.rows).toEqual([{ reply: "echo:ping" }]);
	});

	it("still fails when no resolved address answers, surfacing the dial error", async () => {
		const executor = new IsolateExecutor({
			timeoutMs: 20_000,
			lookup: async () => [{ address: "::1" }],
		});
		await expect(executor.execute(code, job("db.v6-only.test"))).rejects.toThrow(
			/ECONNREFUSED|EADDRNOTAVAIL|ENETUNREACH/,
		);
	});
});

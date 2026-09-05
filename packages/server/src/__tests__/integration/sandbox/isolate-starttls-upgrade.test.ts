import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
	type AddressInfo,
	connect as netConnect,
	createServer as createNetServer,
	type Server,
	type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { createIsolateConnectorCompiler, findBundledConnectorFile } from "@lobu/connector-worker/compile";
import { IsolateExecutor } from "@lobu/connector-worker/executor/isolate";
import { loadIsolatedVm } from "@lobu/connector-worker/isolate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The `postgres` connector reaching an `sslmode=require` database ON THE
 * ISOLATE LANE — the one path no other suite covered, because the embedded test
 * Postgres and CI's Postgres both speak plaintext. Prod connection 501 stopped
 * syncing on the #3337 isolate cutover with `write CONNECT_TIMEOUT`; this
 * reproduces that exact error against the real driver.
 *
 * The transport choreography under test is postgres.js's cloudflare/workerd
 * build (`postgres/cf/polyfills.js`): it derives `secureConnect` — the signal
 * that releases the startup/auth packet — from the PRE-UPGRADE socket's
 * `closed` promise settling, because Cloudflare's `startTls()` consumes the old
 * socket and returns a new one. A `startTls` shim that hands back the same
 * object with a never-settling `closed` therefore parks the driver until its
 * connect_timeout and reports a write timeout on a socket that connected fine.
 *
 * The proxy in front of the test database refuses anything that is not a libpq
 * SSLRequest, so a regression that quietly stops upgrading fails here too
 * rather than passing over an unencrypted socket.
 */
const PACKAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SSL_REQUEST_CODE = 80877103;

describe("isolate lane runs the postgres connector over a STARTTLS upgrade", () => {
	let proxy: Server;
	let proxyPort: number;
	let certDir: string;
	let code: string;
	let sawSslRequest = false;

	beforeAll(async () => {
		if (!(await loadIsolatedVm())) {
			throw new Error(`isolated-vm must load under Node ${process.versions.node} for the isolate lane suite`);
		}

		certDir = mkdtempSync(join(tmpdir(), "lobu-starttls-"));
		const keyPath = join(certDir, "key.pem");
		const certPath = join(certDir, "cert.pem");
		// Self-signed and never verified: the isolate host upgrades with
		// `rejectUnauthorized: false` (the libpq `require` floor documented in
		// `openGuardedPool`), so the subject only has to parse.
		execFileSync(
			"openssl",
			[
				"req", "-x509", "-newkey", "rsa:2048", "-nodes",
				"-keyout", keyPath, "-out", certPath,
				"-days", "1", "-subj", "/CN=lobu-starttls-test",
			],
			{ stdio: "pipe" },
		);
		const key = readFileSync(keyPath, "utf8");
		const cert = readFileSync(certPath, "utf8");

		const upstream = new URL(process.env.DATABASE_URL as string);
		proxy = createNetServer((plain) => {
			// libpq STARTTLS: the client's first message is the 8-byte SSLRequest,
			// the server answers a bare 'S', and the SAME socket becomes TLS.
			let head = Buffer.alloc(0);
			const onHead = (chunk: Buffer) => {
				head = Buffer.concat([head, chunk]);
				if (head.length < 8) return;
				plain.off("data", onHead);
				if (head.readUInt32BE(0) !== 8 || head.readUInt32BE(4) !== SSL_REQUEST_CODE) {
					plain.destroy();
					return;
				}
				sawSslRequest = true;
				plain.write("S");
				const tlsSock = new TLSSocket(plain, { isServer: true, key, cert });
				const up: Socket = netConnect({ host: upstream.hostname, port: Number(upstream.port) });
				tlsSock.pipe(up).pipe(tlsSock);
				tlsSock.on("error", () => up.destroy());
				up.on("error", () => tlsSock.destroy());
			};
			plain.on("data", onHead);
			plain.on("error", () => {});
		});
		await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
		proxyPort = (proxy.address() as AddressInfo).port;

		const connectorFile = findBundledConnectorFile("postgres", [join(PACKAGES_DIR, "connectors/src")]);
		if (!connectorFile) throw new Error("postgres connector source not found");
		code = await createIsolateConnectorCompiler().compileConnectorForIsolateFromFile(connectorFile);
	}, 60_000);

	afterAll(async () => {
		await new Promise<void>((done) => proxy.close(() => done()));
		rmSync(certDir, { recursive: true, force: true });
	});

	it("completes the handshake and returns rows for sslmode=require", async () => {
		const upstream = new URL(process.env.DATABASE_URL as string);
		// `block-private` is the cloud policy, and the only one under which
		// `openGuardedPool` gives postgres.js an `ssl` option at all. The host
		// resolves and dials, so the hostname is allow-listed rather than
		// pre-validated in the guest.
		const databaseUrl = `postgres://${upstream.username}:${upstream.password}@db.starttls.test:${proxyPort}${upstream.pathname}?sslmode=require`;
		const executor = new IsolateExecutor({
			timeoutMs: 30_000,
			lookup: async () => [{ address: "127.0.0.1" }],
		});

		const result = (await executor.execute(code, {
			mode: "query" as const,
			query: "SELECT 1 AS one",
			config: { DATABASE_URL: databaseUrl },
			checkpoint: null,
			credentials: null,
			sessionState: null,
			env: {
				LOBU_DB_EGRESS_POLICY: "block-private",
				LOBU_DB_EGRESS_ALLOW_HOSTS: "db.starttls.test",
			},
		})) as { rows: Array<Record<string, unknown>> };

		expect(result.rows).toEqual([{ one: 1 }]);
		expect(sawSslRequest).toBe(true);
	}, 60_000);
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateWorkerToken } from "@lobu/core";

const remoteFiles = new Map<string, Buffer>();
const mkdirMock = mock(async () => undefined);
const readdirMock = mock(async () => []);
const statMock = mock(async (remotePath: string) => ({
	size: remoteFiles.get(remotePath)?.byteLength ?? 0,
}));
const rmMock = mock(async (remotePath: string) => {
	remoteFiles.delete(remotePath);
});
const writeFilesMock = mock(async () => undefined);
const readFileToBufferMock = mock(async () => null);
const runCommandMock = mock(async (params: { args?: string[] }) => {
	const command = params.args?.[1] ?? "";
	let stdout = "command stdout\n";
	let exitCode = 0;
	if (command.includes("echo remote output > output.txt")) {
		remoteFiles.set("/vercel/sandbox/output.txt", Buffer.from("remote output"));
	}
	if (command.includes("cat input.txt")) {
		const input = remoteFiles.get("/vercel/sandbox/input.txt");
		if (input) {
			stdout = input.toString("utf8");
		} else {
			stdout = "";
			exitCode = 1;
		}
	}
	if (command.includes("cat output.txt")) {
		const output = remoteFiles.get("/vercel/sandbox/output.txt");
		if (output) {
			stdout = output.toString("utf8");
		} else {
			stdout = "";
			exitCode = 1;
		}
	}
	if (command.includes("rm input.txt")) {
		remoteFiles.delete("/vercel/sandbox/input.txt");
	}
	return {
		exitCode,
		stdout: async () => stdout,
		stderr: async () => "",
	};
});
const updateMock = mock(async () => undefined);
const getOrCreateMock = mock(async () => fakeSandbox);

const fakeSandbox = {
	name: "lobu-org-agent-hash",
	persistent: true,
	cwd: "/vercel/sandbox",
	networkPolicy: "deny-all",
	timeout: 60_000,
	vcpus: 2,
	keepLastSnapshots: undefined,
	snapshotExpiration: undefined,
	fs: {
		mkdir: mkdirMock,
		readdir: readdirMock,
		stat: statMock,
		rm: rmMock,
	},
	writeFiles: writeFilesMock,
	readFileToBuffer: readFileToBufferMock,
	runCommand: runCommandMock,
	update: updateMock,
};

mock.module("@vercel/sandbox", () => ({
	Sandbox: { getOrCreate: getOrCreateMock },
}));

const { createVercelSandboxRoutes } = await import(
	"../routes/internal/vercel-sandbox.js"
);

const originalEnv = {
	ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
	LOBU_WORKSPACE_BACKEND: process.env.LOBU_WORKSPACE_BACKEND,
	LOBU_VERCEL_SANDBOX_NAME_PREFIX: process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX,
	LOBU_VERCEL_SANDBOX_RUNTIME: process.env.LOBU_VERCEL_SANDBOX_RUNTIME,
	LOBU_VERCEL_SANDBOX_KEEP_LAST_SNAPSHOTS:
		process.env.LOBU_VERCEL_SANDBOX_KEEP_LAST_SNAPSHOTS,
	LOBU_VERCEL_SANDBOX_SNAPSHOT_EXPIRATION_MS:
		process.env.LOBU_VERCEL_SANDBOX_SNAPSHOT_EXPIRATION_MS,
	LOBU_VERCEL_SANDBOX_DELETE_EVICTED_SNAPSHOTS:
		process.env.LOBU_VERCEL_SANDBOX_DELETE_EVICTED_SNAPSHOTS,
	VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
	VERCEL_SANDBOX_DEFAULT_RUNTIME: process.env.VERCEL_SANDBOX_DEFAULT_RUNTIME,
	VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
	VERCEL_TOKEN: process.env.VERCEL_TOKEN,
};

function restoreEnv(name: keyof typeof originalEnv): void {
	const value = originalEnv[name];
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

function token(options: { agentId?: string } = {}): string {
	return generateWorkerToken("user-1", "conv-1", "deploy-1", {
		channelId: "chan-1",
		teamId: "team-1",
		platform: "slack",
		organizationId: "org-1",
		agentId: options.agentId,
	});
}

beforeEach(() => {
	process.env.ENCRYPTION_KEY =
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

afterEach(async () => {
	restoreEnv("ENCRYPTION_KEY");
	restoreEnv("LOBU_WORKSPACE_BACKEND");
	restoreEnv("LOBU_VERCEL_SANDBOX_NAME_PREFIX");
	restoreEnv("LOBU_VERCEL_SANDBOX_RUNTIME");
	restoreEnv("LOBU_VERCEL_SANDBOX_KEEP_LAST_SNAPSHOTS");
	restoreEnv("LOBU_VERCEL_SANDBOX_SNAPSHOT_EXPIRATION_MS");
	restoreEnv("LOBU_VERCEL_SANDBOX_DELETE_EVICTED_SNAPSHOTS");
	restoreEnv("VERCEL_PROJECT_ID");
	restoreEnv("VERCEL_SANDBOX_DEFAULT_RUNTIME");
	restoreEnv("VERCEL_TEAM_ID");
	restoreEnv("VERCEL_TOKEN");
	remoteFiles.clear();
	getOrCreateMock.mockClear();
	mkdirMock.mockClear();
	readdirMock.mockClear();
	writeFilesMock.mockClear();
	runCommandMock.mockClear();
	statMock.mockClear();
	readFileToBufferMock.mockClear();
	rmMock.mockClear();
	updateMock.mockClear();
	await fs.rm(path.resolve("workspaces", "verceltestagent"), {
		recursive: true,
		force: true,
	});
	mock.restore();
});

describe("createVercelSandboxRoutes", () => {
	test("is unavailable unless the Vercel workspace backend is enabled", async () => {
		delete process.env.LOBU_WORKSPACE_BACKEND;
		const router = createVercelSandboxRoutes();

		const res = await router.request("/internal/vercel-sandbox/exec", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token({ agentId: "agent-1" })}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ command: "pwd" }),
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			error: "Vercel sandbox backend is not enabled",
		});
	});

	test("requires an agent-scoped worker token before sandbox work", async () => {
		process.env.LOBU_WORKSPACE_BACKEND = "vercel";
		const router = createVercelSandboxRoutes();

		const res = await router.request("/internal/vercel-sandbox/exec", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token()}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ command: "pwd" }),
		});

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Token missing agent context" });
	});

	test("rejects a workspace path outside the token conversation", async () => {
		process.env.LOBU_WORKSPACE_BACKEND = "vercel";
		const router = createVercelSandboxRoutes();

		const res = await router.request("/internal/vercel-sandbox/exec", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token({ agentId: "verceltestagent" })}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				command: "pwd",
				workspaceDir: path.resolve("workspaces", "verceltestagent", "other"),
			}),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "Workspace does not match token conversation context",
		});
		expect(getOrCreateMock).not.toHaveBeenCalled();
	});

	test("passes Vercel access-token credentials when configured", async () => {
		process.env.LOBU_WORKSPACE_BACKEND = "vercel";
		process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX = "lobu-test";
		process.env.VERCEL_PROJECT_ID = "prj_test";
		process.env.VERCEL_TEAM_ID = "team_test";
		process.env.VERCEL_TOKEN = "vercel_test_token";
		const workspaceDir = path.resolve(
			"workspaces",
			"verceltestagent",
			"conv-1",
		);

		const router = createVercelSandboxRoutes();
		const res = await router.request("/internal/vercel-sandbox/exec", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token({ agentId: "verceltestagent" })}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ command: "pwd", workspaceDir }),
		});

		expect(res.status).toBe(200);
		expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
			projectId: "prj_test",
			teamId: "team_test",
			token: "vercel_test_token",
		});
	});

	test("fails before Vercel when access-token credentials are partial", async () => {
		process.env.LOBU_WORKSPACE_BACKEND = "vercel";
		process.env.VERCEL_TOKEN = "vercel_test_token";
		delete process.env.VERCEL_TEAM_ID;
		delete process.env.VERCEL_PROJECT_ID;
		const workspaceDir = path.resolve(
			"workspaces",
			"verceltestagent",
			"conv-1",
		);

		const router = createVercelSandboxRoutes();
		const res = await router.request("/internal/vercel-sandbox/exec", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token({ agentId: "verceltestagent" })}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ command: "pwd", workspaceDir }),
		});

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			error:
				"VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID must be set together",
		});
		expect(getOrCreateMock).not.toHaveBeenCalled();
	});

	test("keeps the Vercel sandbox as the workspace source of truth", async () => {
		process.env.LOBU_WORKSPACE_BACKEND = "vercel";
		process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX = "lobu-test";
		const workspaceDir = path.resolve(
			"workspaces",
			"verceltestagent",
			"conv-1",
		);
		await fs.mkdir(workspaceDir, { recursive: true });
		await fs.writeFile(path.join(workspaceDir, "local-only.txt"), "local only");
		remoteFiles.set("/vercel/sandbox/input.txt", Buffer.from("remote input"));

		const router = createVercelSandboxRoutes();
		const res = await router.request("/internal/vercel-sandbox/exec", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token({ agentId: "verceltestagent" })}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				command: "cat input.txt && echo remote output > output.txt",
				workspaceDir,
			}),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			stdout: "remote input",
			stderr: "",
			exitCode: 0,
		});
		expect(remoteFiles.get("/vercel/sandbox/output.txt")?.toString()).toBe(
			"remote output",
		);
		expect(
			await fs.readFile(path.join(workspaceDir, "local-only.txt"), "utf8"),
		).toBe("local only");
		expect(
			await fs
				.stat(path.join(workspaceDir, "output.txt"))
				.then(() => true)
				.catch(() => false),
		).toBe(false);
		expect(mkdirMock).toHaveBeenCalledWith("/vercel/sandbox", {
			recursive: true,
		});
		expect(writeFilesMock).not.toHaveBeenCalled();
		expect(readFileToBufferMock).not.toHaveBeenCalled();
		expect(readdirMock).not.toHaveBeenCalled();
		expect(rmMock).not.toHaveBeenCalled();
	});

	test("executes in a persistent named sandbox without local file sync", async () => {
		process.env.LOBU_WORKSPACE_BACKEND = "vercel";
		process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX = "lobu-test";
		process.env.VERCEL_SANDBOX_DEFAULT_RUNTIME = "node22";
		const workspaceDir = path.resolve(
			"workspaces",
			"verceltestagent",
			"conv-1",
		);
		await fs.mkdir(workspaceDir, { recursive: true });
		const subdir = path.join(workspaceDir, "nested");
		await fs.writeFile(path.join(workspaceDir, "input.txt"), "local input");
		remoteFiles.set("/vercel/sandbox/stale.txt", Buffer.from("stale"));

		const router = createVercelSandboxRoutes();
		const res = await router.request("/internal/vercel-sandbox/exec", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token({ agentId: "verceltestagent" })}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				command: "pwd",
				cwd: subdir,
				workspaceDir,
				timeoutMs: 1_000,
				allowedDomains: ["github.com", ".npmjs.org", "bad domain"],
			}),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			stdout: "command stdout\n",
			stderr: "",
			exitCode: 0,
			sandbox: {
				name: "lobu-org-agent-hash",
				persistent: true,
				cwd: "/vercel/sandbox",
			},
		});
		expect(getOrCreateMock).toHaveBeenCalledTimes(1);
		expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
			name: expect.stringMatching(
				/^lobu-test-org-1-verceltestagent-[a-f0-9]{16}$/,
			),
			persistent: true,
			runtime: "node22",
			resources: { vcpus: 1 },
			networkPolicy: { allow: ["github.com", "*.npmjs.org"] },
			keepLastSnapshots: { count: 1, deleteEvicted: true },
		});
		expect(updateMock.mock.calls[0]?.[0]).toMatchObject({
			networkPolicy: { allow: ["github.com", "*.npmjs.org"] },
			resources: { vcpus: 1 },
			timeout: 600_000,
			keepLastSnapshots: { count: 1, deleteEvicted: true },
		});
		expect(remoteFiles.has("/vercel/sandbox/stale.txt")).toBe(true);
		expect(runCommandMock.mock.calls[0]?.[0]).toMatchObject({
			cmd: "/bin/bash",
			args: ["-lc", "pwd"],
			cwd: "/vercel/sandbox/nested",
			timeoutMs: 1_000,
		});
		expect(writeFilesMock).not.toHaveBeenCalled();
		expect(readFileToBufferMock).not.toHaveBeenCalled();
		expect(rmMock).not.toHaveBeenCalled();
	});

	test("remote deletes do not mutate local workspace files", async () => {
		process.env.LOBU_WORKSPACE_BACKEND = "vercel";
		process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX = "lobu-test";
		const workspaceDir = path.resolve(
			"workspaces",
			"verceltestagent",
			"conv-1",
		);
		await fs.mkdir(workspaceDir, { recursive: true });
		await fs.writeFile(path.join(workspaceDir, "input.txt"), "local input");
		remoteFiles.set("/vercel/sandbox/input.txt", Buffer.from("remote input"));

		const router = createVercelSandboxRoutes();
		const res = await router.request("/internal/vercel-sandbox/exec", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token({ agentId: "verceltestagent" })}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ command: "rm input.txt", workspaceDir }),
		});

		expect(res.status).toBe(200);
		expect(remoteFiles.has("/vercel/sandbox/input.txt")).toBe(false);
		expect(
			await fs.readFile(path.join(workspaceDir, "input.txt"), "utf8"),
		).toBe("local input");
		expect(writeFilesMock).not.toHaveBeenCalled();
		expect(readFileToBufferMock).not.toHaveBeenCalled();
		expect(rmMock).not.toHaveBeenCalled();
	});
});

import { createHash } from "node:crypto";
import path from "node:path";
import { createLogger, sanitizeConversationId } from "@lobu/core";
import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";
import { Hono } from "hono";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";

const logger = createLogger("internal-vercel-sandbox");

const REMOTE_WORKSPACE_DIR = "/vercel/sandbox";

type ExecRequest = {
	command?: unknown;
	cwd?: unknown;
	workspaceDir?: unknown;
	env?: unknown;
	timeoutMs?: unknown;
	allowedDomains?: unknown;
};

type SnapshotRetention = {
	snapshotExpiration?: number;
	keepLastSnapshots?: {
		count: number;
		expiration?: number;
		deleteEvicted?: boolean;
	};
};

type VercelCredentials = {
	token: string;
	teamId: string;
	projectId: string;
};

function enabled(): boolean {
	const value = process.env.LOBU_WORKSPACE_BACKEND?.toLowerCase();
	return value === "vercel" || value === "vercel-sandbox";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (!value) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function snapshotRetention(): SnapshotRetention {
	const snapshotExpiration = parseNonNegativeInt(
		process.env.LOBU_VERCEL_SANDBOX_SNAPSHOT_EXPIRATION_MS,
	);
	const keepCount = Math.min(
		10,
		Math.max(
			1,
			parsePositiveInt(process.env.LOBU_VERCEL_SANDBOX_KEEP_LAST_SNAPSHOTS, 1),
		),
	);
	return {
		...(snapshotExpiration !== undefined ? { snapshotExpiration } : {}),
		keepLastSnapshots: {
			count: keepCount,
			...(snapshotExpiration !== undefined
				? { expiration: snapshotExpiration }
				: {}),
			deleteEvicted: parseBoolean(
				process.env.LOBU_VERCEL_SANDBOX_DELETE_EVICTED_SNAPSHOTS,
				true,
			),
		},
	};
}

function vercelCredentials(): Partial<VercelCredentials> {
	const token = process.env.VERCEL_TOKEN;
	const teamId = process.env.VERCEL_TEAM_ID;
	const projectId = process.env.VERCEL_PROJECT_ID;
	const present = [token, teamId, projectId].filter((value) => !!value).length;
	if (present === 0) return {};
	if (present !== 3 || !token || !teamId || !projectId) {
		throw new Error(
			"VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID must be set together",
		);
	}
	return { token, teamId, projectId };
}

function stableSandboxName(params: {
	organizationId?: string;
	agentId: string;
	conversationId: string;
}): string {
	const prefix = (process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX || "lobu")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	const org = (params.organizationId || "orgless")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	const agent = params.agentId
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	const hash = createHash("sha256")
		.update(
			`${params.organizationId || ""}:${params.agentId}:${params.conversationId}`,
		)
		.digest("hex")
		.slice(0, 16);
	return [prefix || "lobu", org || "orgless", agent || "agent", hash]
		.join("-")
		.slice(0, 100);
}

function normalizeAllowedDomain(domain: string): string | null {
	const trimmed = domain.trim();
	if (!trimmed) return null;
	if (trimmed === "*") return "*";
	if (!/^[A-Za-z0-9.*_-]+(?::\d+)?$/.test(trimmed)) return null;
	if (trimmed.startsWith(".")) return `*${trimmed}`;
	return trimmed;
}

function networkPolicyFromDomains(value: unknown): NetworkPolicy {
	if (!Array.isArray(value)) return "deny-all";
	const domains = value
		.filter((entry): entry is string => typeof entry === "string")
		.map(normalizeAllowedDomain)
		.filter((entry): entry is string => !!entry);
	if (domains.includes("*")) return "allow-all";
	return domains.length > 0
		? { allow: Array.from(new Set(domains)) }
		: "deny-all";
}

function commandEnv(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const env: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			env[key] = raw;
		}
	}
	return env;
}

function errorStatus(error: Error): 400 | 500 {
	if (
		error.message === "Invalid agentId" ||
		error.message === "Workspace resolved outside workspaces root" ||
		error.message === "Workspace does not match token conversation context" ||
		error.message === "cwd must stay inside the workspace"
	) {
		return 400;
	}
	return 500;
}

function resolveWorkspacePath(
	agentId: string,
	conversationId: string,
	requestedWorkspaceDir: unknown,
): string {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) {
		throw new Error("Invalid agentId");
	}
	const root = path.resolve("workspaces");
	const agentRoot = path.resolve(root, agentId);
	const expectedWorkspace = path.resolve(
		agentRoot,
		sanitizeConversationId(conversationId),
	);
	const workspace =
		typeof requestedWorkspaceDir === "string" && requestedWorkspaceDir.trim()
			? path.resolve(requestedWorkspaceDir)
			: expectedWorkspace;
	if (workspace !== agentRoot && !workspace.startsWith(agentRoot + path.sep)) {
		throw new Error("Workspace resolved outside workspaces root");
	}
	if (workspace !== expectedWorkspace) {
		throw new Error("Workspace does not match token conversation context");
	}
	return workspace;
}

function remoteCwd(cwd: unknown, workspaceDir: string): string {
	const raw = typeof cwd === "string" && cwd.trim() ? cwd.trim() : "/";
	let rel = raw;
	if (path.isAbsolute(raw)) {
		const absoluteCwd = path.resolve(raw);
		if (absoluteCwd === workspaceDir) {
			rel = "";
		} else if (absoluteCwd.startsWith(workspaceDir + path.sep)) {
			rel = path.relative(workspaceDir, absoluteCwd);
		} else if (
			raw === REMOTE_WORKSPACE_DIR ||
			raw.startsWith(`${REMOTE_WORKSPACE_DIR}/`)
		) {
			rel = path.posix.relative(REMOTE_WORKSPACE_DIR, raw);
		} else {
			rel = raw.slice(1);
		}
	}
	const normalized = path.posix.normalize(`/${rel}`).slice(1);
	if (normalized === "" || normalized === ".") return REMOTE_WORKSPACE_DIR;
	if (normalized.split("/").includes("..")) {
		throw new Error("cwd must stay inside the workspace");
	}
	return path.posix.join(REMOTE_WORKSPACE_DIR, normalized);
}

async function getSandbox(params: {
	name: string;
	networkPolicy: NetworkPolicy;
}): Promise<Sandbox> {
	const timeout = parsePositiveInt(
		process.env.LOBU_VERCEL_SANDBOX_TIMEOUT_MS,
		parsePositiveInt(process.env.TIMEOUT_MINUTES, 10) * 60 * 1000,
	);
	const vcpus = parsePositiveInt(process.env.LOBU_VERCEL_SANDBOX_VCPUS, 1);
	const runtime =
		process.env.LOBU_VERCEL_SANDBOX_RUNTIME ||
		process.env.VERCEL_SANDBOX_DEFAULT_RUNTIME ||
		"node24";
	const retention = snapshotRetention();
	const sandbox = await Sandbox.getOrCreate({
		name: params.name,
		...vercelCredentials(),
		persistent: true,
		runtime,
		timeout,
		resources: { vcpus },
		networkPolicy: params.networkPolicy,
		...retention,
		tags: { app: "lobu", backend: "worker" },
	});

	if (
		JSON.stringify(sandbox.networkPolicy) !==
			JSON.stringify(params.networkPolicy) ||
		sandbox.timeout !== timeout ||
		sandbox.vcpus !== vcpus ||
		JSON.stringify(sandbox.keepLastSnapshots) !==
			JSON.stringify(retention.keepLastSnapshots) ||
		sandbox.snapshotExpiration !== retention.snapshotExpiration
	) {
		await sandbox.update({
			networkPolicy: params.networkPolicy,
			resources: { vcpus },
			timeout,
			...retention,
		});
	}
	return sandbox;
}

export function createVercelSandboxRoutes(): Hono<WorkerContext> {
	const router = new Hono<WorkerContext>();

	router.post(
		"/internal/vercel-sandbox/exec",
		authenticateWorker,
		async (c) => {
			if (!enabled()) {
				return errorResponse(c, "Vercel sandbox backend is not enabled", 404);
			}

			try {
				const worker = getVerifiedWorker(c);
				if (!worker.agentId) {
					return errorResponse(c, "Token missing agent context", 403);
				}

				const body = (await c.req
					.json()
					.catch(() => null)) as ExecRequest | null;
				if (!body || typeof body.command !== "string" || !body.command.trim()) {
					return errorResponse(c, "Missing command", 400);
				}

				const workspaceDir = resolveWorkspacePath(
					worker.agentId,
					worker.conversationId,
					body.workspaceDir,
				);
				const sandboxName = stableSandboxName({
					organizationId: worker.organizationId,
					agentId: worker.agentId,
					conversationId: worker.conversationId,
				});
				const networkPolicy = networkPolicyFromDomains(body.allowedDomains);
				const sandbox = await getSandbox({ name: sandboxName, networkPolicy });

				await sandbox.fs.mkdir(REMOTE_WORKSPACE_DIR, { recursive: true });

				const timeoutMs =
					typeof body.timeoutMs === "number" &&
					Number.isFinite(body.timeoutMs) &&
					body.timeoutMs > 0
						? Math.floor(body.timeoutMs)
						: undefined;

				const result = await sandbox.runCommand({
					cmd: "/bin/bash",
					args: ["-lc", body.command],
					cwd: remoteCwd(body.cwd, workspaceDir),
					env: commandEnv(body.env),
					timeoutMs,
				});
				const [stdout, stderr] = await Promise.all([
					result.stdout(),
					result.stderr(),
				]);

				return c.json({
					stdout,
					stderr,
					exitCode: result.exitCode,
					sandbox: {
						name: sandbox.name,
						persistent: sandbox.persistent,
						cwd: sandbox.cwd,
					},
				});
			} catch (error) {
				logger.error(
					{ err: error instanceof Error ? error.message : String(error) },
					"Vercel sandbox exec failed",
				);
				return errorResponse(
					c,
					error instanceof Error ? error.message : "Vercel sandbox exec failed",
					error instanceof Error ? errorStatus(error) : 500,
				);
			}
		},
	);

	return router;
}

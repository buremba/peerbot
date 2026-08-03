import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postgres = vi.hoisted(() => ({
	initialise: vi.fn<() => Promise<void>>(),
	start: vi.fn<() => Promise<void>>(),
	stop: vi.fn<() => Promise<void>>(),
}));

vi.mock("embedded-postgres", () => ({
	default: class FakeEmbeddedPostgres {
		initialise = postgres.initialise;
		start = postgres.start;
		stop = postgres.stop;
	},
}));

vi.mock("@lobu/pgvector-embedded", () => ({
	injectPgvector: vi.fn(),
	resolveEmbeddedNativeDir: () => process.cwd(),
}));

import { startEmbeddedRuntime } from "../embedded-runtime";

describe("startEmbeddedRuntime boot failure cleanup", () => {
	const roots: string[] = [];
	const originalDatabaseUrl = process.env.DATABASE_URL;
	const originalPgSslMode = process.env.PGSSLMODE;
	const originalSingleUser = process.env.LOBU_SINGLE_USER;

	beforeEach(() => {
		postgres.initialise.mockResolvedValue();
		postgres.start.mockRejectedValue(new Error("postgres start failed"));
		postgres.stop.mockImplementation(() => new Promise(() => undefined));
		vi.spyOn(process, "getuid").mockReturnValue(501);
		const root = mkdtempSync(join(tmpdir(), "lobu-pg-start-failure-"));
		roots.push(root);
		process.env.DATABASE_URL = `file://${root}`;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		postgres.initialise.mockReset();
		postgres.start.mockReset();
		postgres.stop.mockReset();
		if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = originalDatabaseUrl;
		if (originalPgSslMode === undefined) delete process.env.PGSSLMODE;
		else process.env.PGSSLMODE = originalPgSslMode;
		if (originalSingleUser === undefined) delete process.env.LOBU_SINGLE_USER;
		else process.env.LOBU_SINGLE_USER = originalSingleUser;
		while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
	});

	it("does not call the dependency's hanging stop() after start() rejects", async () => {
		await expect(startEmbeddedRuntime()).rejects.toThrow("postgres start failed");

		expect(postgres.initialise).toHaveBeenCalledOnce();
		expect(postgres.start).toHaveBeenCalledOnce();
		expect(postgres.stop).not.toHaveBeenCalled();
	});
});

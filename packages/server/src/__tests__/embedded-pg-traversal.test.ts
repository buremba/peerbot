import {
	chmodSync,
	chownSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ensureEmbeddedPostgresIdentity,
	ensureEmbeddedPgTraversal,
	type EmbeddedPostgresIdentity,
} from "../embedded-runtime";

// Root-mode boot: embedded-postgres refuses to run as root, so it drops the
// cluster to a `postgres` user. That user must be able to *traverse* every
// ancestor of the paths it touches — the embedded binaries and the datadir — or
// the setuid spawn dies with EACCES before exec. Grant only that OS group
// traverse access (`g+x`, never read/write), then restore the original
// ownership/mode when PostgreSQL stops.
describe("ensureEmbeddedPgTraversal", () => {
	const dirs: string[] = [];
	const originalCwd = process.cwd();
	const processGid = process.getgid?.();
	const alternateGroups =
		process.getgroups?.().filter((gid) => gid !== processGid) ?? [];
	afterEach(() => {
		process.chdir(originalCwd);
		while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	function fixture(): string {
		// Keep the fixture below the repo rather than macOS's protected per-user
		// temp root (`sunlnk`), whose mode cannot be changed even by its owner.
		const root = mkdtempSync(join(originalCwd, ".lobu-pgtrav-"));
		dirs.push(root);
		return root;
	}

	function postgresIdentity(): EmbeddedPostgresIdentity {
		const uid = typeof process.getuid === "function" ? process.getuid() : 501;
		const gid = typeof process.getgid === "function" ? process.getgid() : 20;
		return { uid: uid + 1, gid, groups: new Set([gid]) };
	}

	it("grants scoped traversal on inaccessible ancestors and restores it", () => {
		const root = fixture();
		const home = join(root, "home");
		const cache = join(home, "npx", "node_modules", "@lobu", "cli");
		mkdirSync(cache, { recursive: true });
		chmodSync(home, 0o700);
		chmodSync(join(home, "npx"), 0o700);

		const lease = ensureEmbeddedPgTraversal([cache], postgresIdentity());

		expect(lease.granted).toContain(home);
		expect(lease.granted).toContain(join(home, "npx"));
		expect(lstatSync(home).mode & 0o010).toBe(0o010);
		expect(lstatSync(home).mode & 0o001).toBe(0);
		expect(lstatSync(join(home, "npx")).mode & 0o010).toBe(0o010);
		expect(lstatSync(join(home, "npx")).mode & 0o001).toBe(0);
		// An already-traversable component is left alone.
		expect(lease.granted).not.toContain(cache);

		lease.restore();
		expect(lstatSync(home).mode & 0o777).toBe(0o700);
		expect(lstatSync(join(home, "npx")).mode & 0o777).toBe(0o700);
	});

	it("is idempotent — a second run grants nothing new", () => {
		const root = fixture();
		const home = join(root, "home");
		const target = join(home, "npx");
		mkdirSync(target, { recursive: true });
		chmodSync(home, 0o700);
		const identity = postgresIdentity();

		const first = ensureEmbeddedPgTraversal([target], identity);
		expect(lstatSync(home).mode & 0o010).toBe(0o010);

		const second = ensureEmbeddedPgTraversal([target], identity);
		expect(second.granted).toEqual([]);
		second.restore();
		first.restore();
		expect(lstatSync(home).mode & 0o777).toBe(0o700);
	});

	it("no-ops when every component is already traversable", () => {
		const root = fixture();
		chmodSync(root, 0o755);
		const lease = ensureEmbeddedPgTraversal([root], postgresIdentity());
		expect(lease.granted).toEqual([]);
		lease.restore();
	});

	it("creates a missing datadir ancestor and makes it traversable (cold boot)", () => {
		const root = fixture();
		const dataRoot = join(root, "home", ".lobu");
		// Reproduce the 0077 umask of a root container that created the parent.
		const previousUmask = process.umask(0o077);
		try {
			const lease = ensureEmbeddedPgTraversal([dataRoot], postgresIdentity());
			expect(lease.granted).toContain(dataRoot);
			expect(lstatSync(dataRoot).isDirectory()).toBe(true);
			expect(lstatSync(dataRoot).mode & 0o010).toBe(0o010);
			expect(lstatSync(dataRoot).mode & 0o001).toBe(0);
			lease.restore();
			expect(lstatSync(dataRoot).mode & 0o777).toBe(0o700);
		} finally {
			process.umask(previousUmask);
		}
	});

	it("walks absolute parents for the documented relative file://. shape", () => {
		const root = fixture();
		const restricted = join(root, "restricted");
		const project = join(restricted, "project");
		mkdirSync(project, { recursive: true });
		chmodSync(project, 0o700);
		process.chdir(project);
		chmodSync(restricted, 0o700);

		const lease = ensureEmbeddedPgTraversal([".lobu"], postgresIdentity());

		expect(lease.granted).toContain(restricted);
		expect(lease.granted).toContain(project);
		expect(lstatSync(restricted).mode & 0o010).toBe(0o010);
		lease.restore();
		expect(lstatSync(restricted).mode & 0o777).toBe(0o700);
	});

	it("walks both a symlink's lexical ancestors and its real target", () => {
		const root = fixture();
		const lexicalParent = join(root, "lexical");
		const realParent = join(root, "real");
		const realTarget = join(realParent, "native");
		mkdirSync(lexicalParent);
		mkdirSync(realTarget, { recursive: true });
		chmodSync(lexicalParent, 0o700);
		chmodSync(realParent, 0o700);
		const link = join(lexicalParent, "native");
		symlinkSync(realTarget, link);

		const lease = ensureEmbeddedPgTraversal([link], postgresIdentity());

		expect(lease.granted).toContain(lexicalParent);
		expect(lease.granted).toContain(realParent);
		expect(lstatSync(lexicalParent).mode & 0o010).toBe(0o010);
		expect(lstatSync(realParent).mode & 0o010).toBe(0o010);
		lease.restore();
		expect(lstatSync(lexicalParent).mode & 0o777).toBe(0o700);
		expect(lstatSync(realParent).mode & 0o777).toBe(0o700);
	});

	it.skipIf(processGid === undefined || alternateGroups.length < 2)(
		"temporarily reassigns group ownership without granting group read/write",
		() => {
			const root = fixture();
			const target = join(root, "private");
			mkdirSync(target);
			chownSync(target, process.getuid!(), alternateGroups[1]!);
			chmodSync(target, 0o750);
			const original = lstatSync(target);
			const chowns: Array<[string, number, number]> = [];
			const operations: string[] = [];
			const identity: EmbeddedPostgresIdentity = {
				uid: original.uid + 1,
				gid: alternateGroups[0]!,
				groups: new Set([processGid!, alternateGroups[0]!]),
			};

			const lease = ensureEmbeddedPgTraversal([target], identity, {
				chmod: (path, mode) => {
					operations.push(`chmod:${String(path)}:${mode.toString(8)}`);
					chmodSync(path, mode);
				},
				chown: (path, uid, gid) => {
					operations.push(`chown:${String(path)}:${uid}:${gid}`);
					chowns.push([String(path), uid, gid]);
					chownSync(path, uid, gid);
				},
			});

			expect(operations.slice(0, 3)).toEqual([
				`chmod:${target}:700`,
				`chown:${target}:${original.uid}:${identity.gid}`,
				`chmod:${target}:710`,
			]);
			expect(chowns).toContainEqual([target, original.uid, identity.gid]);
			expect(lstatSync(target).gid).toBe(identity.gid);
			expect(lstatSync(target).mode & 0o070).toBe(0o010);
			lease.restore();
			expect(operations.slice(-3)).toEqual([
				`chmod:${target}:700`,
				`chown:${target}:${original.uid}:${original.gid}`,
				`chmod:${target}:750`,
			]);
			expect(chowns).toContainEqual([target, original.uid, original.gid]);
			expect(lstatSync(target).gid).toBe(original.gid);
			expect(lstatSync(target).mode & 0o777).toBe(0o750);
		},
	);

	it("fails closed and rolls back an already-applied grant", () => {
		const root = fixture();
		const target = join(root, "private");
		mkdirSync(target);
		chmodSync(target, 0o700);
		chmodSync(root, 0o700);
		let chmodCalls = 0;

		expect(() =>
			ensureEmbeddedPgTraversal([target], postgresIdentity(), {
				chown: chownSync,
				// The walk grants leaf-first, so failing on the SECOND chmod leaves
				// `target` already widened to 0o710. Asserting it is 0o700 after the
				// throw therefore proves the rollback ran, not merely that the failed
				// grant was never applied.
				chmod: (path, mode) => {
					chmodCalls++;
					if (chmodCalls === 2) throw new Error("read-only mount");
					chmodSync(path, mode);
				},
			}),
		).toThrow(/Could not grant the postgres OS user traversal/);
		expect(lstatSync(target).mode & 0o777).toBe(0o700);
		expect(lstatSync(root).mode & 0o777).toBe(0o700);
	});
});

describe("ensureEmbeddedPostgresIdentity", () => {
	it("returns an existing non-root postgres identity", () => {
		const run = vi.fn((command: string, args: string[]) => {
			expect(command).toBe("id");
			if (args[0] === "-u") return "101";
			if (args[0] === "-g") return "102";
			if (args[0] === "-G") return "102 103";
			throw new Error(`unexpected args: ${args.join(" ")}`);
		});

		expect(ensureEmbeddedPostgresIdentity(run)).toEqual({
			uid: 101,
			gid: 102,
			groups: new Set([102, 103]),
		});
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("creates the postgres group/user before returning their identity", () => {
		let exists = false;
		const run = vi.fn((command: string, args: string[]) => {
			if (command === "groupadd") return "";
			if (command === "useradd") {
				exists = true;
				return "";
			}
			if (!exists) throw new Error("no such user");
			if (args[0] === "-u") return "201";
			if (args[0] === "-g") return "202";
			if (args[0] === "-G") return "202";
			throw new Error(`unexpected args: ${args.join(" ")}`);
		});

		expect(ensureEmbeddedPostgresIdentity(run).uid).toBe(201);
		expect(run).toHaveBeenCalledWith("groupadd", ["-f", "postgres"]);
		expect(run).toHaveBeenCalledWith("useradd", [
			"-g",
			"postgres",
			"postgres",
		]);
	});

	it("reports an actionable error when the identity cannot be created", () => {
		expect(() =>
			ensureEmbeddedPostgresIdentity(() => {
				throw new Error("command unavailable");
			}),
		).toThrow(/could not resolve or create it with groupadd\/useradd/);
	});

	it("rejects a postgres identity that resolves to uid 0", () => {
		const run = vi.fn((command: string, args: string[]) => {
			if (command === "groupadd" || command === "useradd") return "";
			if (args[0] === "-u") return "0";
			if (args[0] === "-g") return "0";
			if (args[0] === "-G") return "0";
			throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
		});

		expect(() => ensureEmbeddedPostgresIdentity(run)).toThrow(
			/postgres OS user unexpectedly resolves to uid 0/,
		);
		expect(run).toHaveBeenCalledTimes(3);
	});
});

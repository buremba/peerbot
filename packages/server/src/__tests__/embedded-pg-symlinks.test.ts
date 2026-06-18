import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hydrateEmbeddedPgSymlinks } from "../embedded-runtime";

// #1371: the @embedded-postgres binary's SONAME symlinks (created by a postinstall
// npm runs but bun skips) must be hydrated at boot so the bundled libs load.
describe("hydrateEmbeddedPgSymlinks", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	function fixture(): string {
		const root = mkdtempSync(join(tmpdir(), "lobu-pgsym-"));
		dirs.push(root);
		const lib = join(root, "native", "lib");
		mkdirSync(lib, { recursive: true });
		writeFileSync(join(lib, "libicuuc.so.60.2"), "x");
		writeFileSync(join(lib, "libpq.so.5.18"), "x");
		writeFileSync(
			join(root, "native", "pg-symlinks.json"),
			JSON.stringify([
				{ source: "native/lib/libicuuc.so.60.2", target: "native/lib/libicuuc.so.60" },
				{ source: "native/lib/libpq.so.5.18", target: "native/lib/libpq.so.5" },
			])
		);
		return root;
	}

	it("creates the missing SONAME symlinks pointing at the bundled libs", () => {
		const root = fixture();
		hydrateEmbeddedPgSymlinks(join(root, "native"));
		const icu = join(root, "native", "lib", "libicuuc.so.60");
		const pq = join(root, "native", "lib", "libpq.so.5");
		expect(lstatSync(icu).isSymbolicLink()).toBe(true);
		expect(readlinkSync(icu)).toBe("libicuuc.so.60.2");
		expect(readlinkSync(pq)).toBe("libpq.so.5.18");
	});

	it("is idempotent — a second run does not throw or duplicate", () => {
		const root = fixture();
		hydrateEmbeddedPgSymlinks(join(root, "native"));
		expect(() => hydrateEmbeddedPgSymlinks(join(root, "native"))).not.toThrow();
		expect(readlinkSync(join(root, "native", "lib", "libpq.so.5"))).toBe("libpq.so.5.18");
	});

	it("leaves an already-correct symlink alone", () => {
		const root = fixture();
		symlinkSync("libpq.so.5.18", join(root, "native", "lib", "libpq.so.5"));
		expect(() => hydrateEmbeddedPgSymlinks(join(root, "native"))).not.toThrow();
		expect(readlinkSync(join(root, "native", "lib", "libpq.so.5"))).toBe("libpq.so.5.18");
	});

	it("no-ops when the manifest is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "lobu-pgsym-"));
		dirs.push(root);
		mkdirSync(join(root, "native"), { recursive: true });
		expect(() => hydrateEmbeddedPgSymlinks(join(root, "native"))).not.toThrow();
		expect(existsSync(join(root, "native", "lib"))).toBe(false);
	});
});

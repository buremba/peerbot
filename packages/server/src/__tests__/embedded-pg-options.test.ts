import { describe, expect, it } from "vitest";
import { embeddedPgOptions } from "../embedded-runtime";

// #1364: embedded Postgres must initdb with an always-present locale so `lobu run`
// boots on a minimal Linux box where the host locale (e.g. LANG=en_GB.UTF-8) is
// set but not generated.
describe("embeddedPgOptions", () => {
	it("pins initdb to the C locale with UTF-8 encoding", () => {
		const opts = embeddedPgOptions("/tmp/pgdata", 5599);
		expect(opts.initdbFlags).toEqual(["--locale=C", "--encoding=UTF8"]);
	});

	it("passes through the data dir and port", () => {
		const opts = embeddedPgOptions("/var/lib/lobu/pg", 6123);
		expect(opts.databaseDir).toBe("/var/lib/lobu/pg");
		expect(opts.port).toBe(6123);
		expect(opts.persistent).toBe(true);
	});
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Class guard, complementing the runtime-affecting
 * "pins both entity-schema discriminators against caller input" case in
 * `sdk-signature-contract.test.ts`. That test proves `entitySchema` is fixed;
 * this one stops a NEW namespace reintroducing the shape it was fixed from —
 * building the payload first, then reading the discriminator back off it:
 *
 *   callEntity({ action: "list", ...input }, "listTypes")
 *   // -> action(payload.action as string, …)   // caller picks the handler
 *
 * `action()` strips a caller-supplied `action` key for exactly this reason,
 * which only holds if the name it is handed is a literal from the call site.
 */

const NAMESPACE_DIR = join(__dirname, "../../../sandbox/namespaces");

function namespaceSources(): { file: string; src: string }[] {
	return readdirSync(NAMESPACE_DIR)
		.filter((f) => f.endsWith(".ts"))
		.map((file) => ({
			file,
			src: readFileSync(join(NAMESPACE_DIR, file), "utf8"),
		}));
}

describe("SDK namespace action discriminators", () => {
	it("never derives the action name from caller-supplied data", () => {
		// `action-call.ts` is the helper that strips the key; its own
		// destructuring reference is the one legitimate mention.
		const offenders = namespaceSources()
			.filter(({ file }) => file !== "action-call.ts")
			.filter(({ src }) =>
				/\b(payload|input|args|rest)\s*(\.|\[["'])action\b/.test(src)
			)
			.map(({ file }) => file);

		expect(offenders).toEqual([]);
	});

	it("finds the namespace sources it claims to check", () => {
		// Without this the glob could match nothing and pass vacuously.
		expect(namespaceSources().length).toBeGreaterThan(5);
	});
});

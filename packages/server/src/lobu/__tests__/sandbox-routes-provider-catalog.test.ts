/**
 * `GET /sandboxes` → `providerCatalog` shape contract.
 *
 * The catalog exists so the create form can render a provider's credential
 * fields without hardcoding them. It is display metadata only: it must never
 * carry a credential VALUE, and it must not echo `systemEnvVar` — that names a
 * deployment-wide env var and is operator detail, not something the browser
 * needs in order to draw a form.
 *
 * Asserted against the real registry rather than a fixture, so adding a
 * provider (or a field to one) is covered without touching this file.
 */

import { describe, expect, it } from "vitest";
// The barrel, not `./registry` — providers self-register as an import side
// effect there, so importing the registry alone yields an empty map.
import {
	getGatewayRuntimeProvider,
	listGatewayRuntimeProviderIds,
} from "../../gateway/runtime/index.js";

/** Mirrors the projection in `sandbox-routes.ts`'s GET /. */
function buildProviderCatalog() {
	return listGatewayRuntimeProviderIds().flatMap((id) => {
		const provider = getGatewayRuntimeProvider(id);
		if (!provider) return [];
		return [
			{
				id,
				credentialFields: provider.credentialFields.map(
					({ key, label, required, secret }) => ({
						key,
						label,
						required,
						secret,
					}),
				),
			},
		];
	});
}

const ALLOWED_FIELD_KEYS = ["key", "label", "required", "secret"].sort();

describe("GET /sandboxes providerCatalog contract", () => {
	it("exposes every registered runtime provider", () => {
		const catalog = buildProviderCatalog();
		expect(catalog.length).toBe(listGatewayRuntimeProviderIds().length);
		expect(catalog.length).toBeGreaterThan(0);
	});

	it("emits only display metadata — never systemEnvVar or a credential value", () => {
		for (const entry of buildProviderCatalog()) {
			for (const field of entry.credentialFields) {
				expect(Object.keys(field).sort()).toEqual(ALLOWED_FIELD_KEYS);
				expect(field).not.toHaveProperty("systemEnvVar");
				expect(field).not.toHaveProperty("value");
			}
		}
	});

	it("keeps each field's key and secret flag faithful to the registry", () => {
		for (const entry of buildProviderCatalog()) {
			const provider = getGatewayRuntimeProvider(entry.id);
			expect(provider).toBeTruthy();
			expect(entry.credentialFields.map((f) => f.key)).toEqual(
				provider?.credentialFields.map((f) => f.key),
			);
			// `secret` drives whether the form masks the input, so a dropped flag
			// would render an API token as plain text.
			expect(entry.credentialFields.map((f) => f.secret)).toEqual(
				provider?.credentialFields.map((f) => f.secret),
			);
		}
	});
});

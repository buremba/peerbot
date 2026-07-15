/**
 * Server-side AJV singleton.
 *
 * The construction + error formatting now live in `@lobu/core/ajv` (shared with
 * the CLI's `lobu apply` connector-config validation). This module pins the
 * server's options and memoizes one instance.
 *
 * `allErrors` is intentionally OFF (fail-fast). These instances validate
 * UNTRUSTED metadata from agent tool calls and the public REST surface; with
 * `allErrors: true` an adversary can craft an object that forces AJV to
 * allocate an unbounded number of error objects (CWE-400 / CodeQL
 * `js/resource-exhaustion-from-deep-object-traversal`). Reporting only the
 * first error caps that cost while still giving callers actionable feedback.
 * Callers additionally bound the input via `exceedsValidationLimits` before
 * calling `validate` (see metadata-limits.ts).
 */

import { createAjv } from "@lobu/core/ajv";
import type Ajv from "ajv";

export { formatAjvError } from "@lobu/core/ajv";

let ajvInstance: Ajv | null = null;

export function getAjv(): Ajv {
	if (!ajvInstance) {
		ajvInstance = createAjv({
			allErrors: false,
			strict: false,
			coerceTypes: true,
		});
	}
	return ajvInstance;
}

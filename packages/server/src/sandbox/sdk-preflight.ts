import type { MethodAccess } from "./method-metadata";
import { METHOD_METADATA } from "./method-metadata";
import { getArgsValidator } from "../tools/validate-args";

export interface SdkPreflightResult {
	args: unknown[];
	required_access: MethodAccess;
	authorization_status: "not_evaluated";
}

export type SdkPreflight = (
	...args: unknown[]
) => SdkPreflightResult | Promise<SdkPreflightResult>;

const SDK_PREFLIGHT = Symbol("lobu.sdk-preflight");

interface ValidatedSdkMethodOptions<TArgs extends unknown[]> {
	path: string;
	prepareArgs: (...args: TArgs) => unknown;
	projectArgs?: (validated: unknown) => unknown[];
	rewriteError?: (error: unknown) => unknown;
	transformResult?: (result: unknown) => unknown;
}

/**
 * Build an SDK method and its dry-run adapter from the same `withValidatedArgs`
 * handler. Live calls always enter that handler; preflight calls run only its
 * exposed validator after pure public-to-handler canonicalization.
 */
export function createValidatedSdkMethod<
	TArgs extends unknown[] = any[],
	TResult = unknown,
>(
	validatedHandler: unknown,
	handlerArgs: readonly unknown[],
	options: ValidatedSdkMethodOptions<TArgs>,
): (...args: TArgs) => Promise<TResult> {
	const validate = getArgsValidator(validatedHandler);
	if (!validate) {
		throw new Error(
			`SDK preflight source for '${options.path}' is not wrapped with withValidatedArgs`,
		);
	}
	const metadata = METHOD_METADATA[options.path];
	if (!metadata) {
		throw new Error(`Missing SDK method metadata for '${options.path}'`);
	}
	const preflight: SdkPreflight = (...args) => {
		let validated: unknown;
		try {
			validated = validate(options.prepareArgs(...(args as TArgs)));
		} catch (error) {
			throw options.rewriteError?.(error) ?? error;
		}
		return {
			args: options.projectArgs?.(validated) ?? [validated],
			required_access: metadata.access,
			authorization_status: "not_evaluated",
		};
	};
	const method = async (...args: TArgs): Promise<TResult> => {
		try {
			const result = await (validatedHandler as (
				input: unknown,
				...rest: unknown[]
			) => unknown)(options.prepareArgs(...args), ...handlerArgs);
			return (options.transformResult
				? options.transformResult(result)
				: result) as TResult;
		} catch (error) {
			throw options.rewriteError?.(error) ?? error;
		}
	};
	Object.defineProperty(method, SDK_PREFLIGHT, {
		value: preflight,
		enumerable: false,
	});
	return method;
}

export function getSdkPreflight(value: unknown): SdkPreflight | undefined {
	return typeof value === "function"
		? (value as unknown as Record<symbol, SdkPreflight | undefined>)[
				SDK_PREFLIGHT
			]
		: undefined;
}

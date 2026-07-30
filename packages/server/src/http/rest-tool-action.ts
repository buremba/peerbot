/** Compose caller args with the route's server-selected action last. */
export function fixedActionArgs(
	action: string,
	callerArgs?: Record<string, unknown>
): Record<string, unknown> {
	return { ...callerArgs, action };
}

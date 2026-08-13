import { ToolUserError } from "../utils/errors";

export const DEFAULT_PAGE_ACTIVATION_SECONDS = 86_400;

export function normalizePageActivationUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ToolUserError(`Invalid page activation URL '${value}'.`, 422);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ToolUserError("Page activation URLs must use HTTP or HTTPS.", 422);
	}
	url.hash = "";
	url.search = "";
	// Hostname case and default ports are already canonicalized by URL parsing;
	// only the trailing-slash trim is normalization the parser does not do.
	if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString();
}

export function normalizePageActivationUrls(values: string[]): string[] {
	const urls = [...new Set(values.map(normalizePageActivationUrl))];
	if (urls.length === 0 || urls.length > 8) {
		throw new ToolUserError("Page activation requires between 1 and 8 unique URLs.", 422);
	}
	return urls;
}

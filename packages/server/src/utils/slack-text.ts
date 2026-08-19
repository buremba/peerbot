/**
 * Slack mrkdwn text handling, shared by every surface that writes it.
 *
 * There were two byte-identical copies of this before — one in the notification
 * card builder, one in the App Home bridge — which is exactly the shape of bug
 * that survives review: both were correct, and nothing stopped them drifting
 * apart the next time either surface grew a case.
 */

/**
 * Escape text bound for Slack **mrkdwn**.
 *
 * Load-bearing wherever the text is not authored by us: unescaped, `<!channel>`
 * pings the room from inside a trusted card, and `<https://evil|Review in Lobu>`
 * renders a link spoofing the genuine one.
 *
 * NOT for native table cells — the adapter emits those as `raw_text`, which is
 * never parsed for entities, so escaping there shows the reader a literal
 * `&lt;`.
 */
export function escapeSlackText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Slack rejects a whole `section` — and with it the entire message or
 * `views.publish` — when its text exceeds 3000 characters. A list built from
 * user data has no natural bound, so callers must clamp before joining.
 */
export const MAX_SECTION_CHARS = 3000;

/**
 * Join `lines` into one section body that Slack will accept, dropping the tail
 * rather than the message. Returns the text plus how many lines were omitted so
 * the caller can say so instead of silently showing a prefix.
 */
export function joinSectionLines(
	lines: string[],
	options: { header?: string; limit?: number } = {},
): { text: string; omitted: number } {
	const budget = (options.limit ?? MAX_SECTION_CHARS) - 120;
	const header = options.header ? `${options.header}\n` : "";
	const kept: string[] = [];
	let used = header.length;
	for (const line of lines) {
		if (used + line.length + 1 > budget) break;
		kept.push(line);
		used += line.length + 1;
	}
	const omitted = lines.length - kept.length;
	const more = omitted > 0 ? `\n_…and ${omitted} more_` : "";
	return { text: `${header}${kept.join("\n")}${more}`, omitted };
}

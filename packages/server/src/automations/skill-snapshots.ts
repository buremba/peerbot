export interface AutomationSkillSnapshot {
	name: string;
	content: string;
}

/**
 * Parse the durable jsonb representation used by run dispatch. Invalid rows
 * throw so callers fail the run rather than silently executing without skills.
 */
export function parseAutomationSkillSnapshots(
	value: unknown,
): AutomationSkillSnapshot[] {
	let parsed = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			throw new Error("Automation version has malformed pinned skills");
		}
	}
	if (parsed == null) return [];
	if (!Array.isArray(parsed)) {
		throw new Error("Automation version has malformed pinned skills");
	}
	return parsed.map((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.name !== "string" ||
			!entry.name.trim() ||
			typeof entry.content !== "string" ||
			!entry.content.trim()
		) {
			throw new Error("Automation version has malformed pinned skills");
		}
		return { name: entry.name, content: entry.content };
	});
}

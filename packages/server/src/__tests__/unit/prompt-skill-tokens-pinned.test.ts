/**
 * A prompt `@[skill:…]` chip must have a matching entry in `skills[]`.
 *
 * Ref tokens are never stripped — nothing in the instruction path rewrites them
 * (grep `REF_TOKEN`: every consumer only reads the prompt) — so an unpinned
 * chip does not fail loudly, it degrades: the agent reads the literal
 * `@[skill:deploy-runbook:Deploy runbook](/…)` as if it were guidance, with no
 * `.skills/` file behind it. Silent wrong instructions are worse than a 422.
 *
 * The check is deliberately ONE-directional. A pinned skill with no chip is
 * legal — that is the declarative path (`defineAutomation({ skills: [...] })`
 * carries no prompt at all), and rejecting it would strand every CLI-authored
 * Automation.
 */

import { describe, expect, it } from "bun:test";
import { assertPromptSkillTokensPinned } from "../../tools/admin/manage_automations/shared";
import { skillNamesFromPrompt } from "../../automations/source-refs";

const chip = (name: string, label = name) =>
	`@[skill:${name}:${label}](/acme/agents/a/skills/${name})`;

describe("skillNamesFromPrompt", () => {
	it("reads the id out of a skill chip, not the label", () => {
		expect(
			skillNamesFromPrompt(
				`Run ${chip("deploy-runbook", "Deploy runbook")} nightly.`,
			),
		).toEqual(["deploy-runbook"]);
	});

	it("ignores every other ref kind", () => {
		// These are sources or scoping, and each already has its own handling.
		// A skill token must not become a source and a source must not become a
		// pinned skill.
		const prompt = [
			"@[feed:inbox:Inbox](/acme/feeds/inbox)",
			"@[connection:42:Stripe](/acme/connectors/stripe/42)",
			"@[entity:7:Spotify](/acme/company/spotify)",
			"@[metric:asset.spend:Spend](/acme/metrics/asset.spend)",
		].join(" ");
		expect(skillNamesFromPrompt(prompt)).toEqual([]);
	});

	it("de-dupes repeats but keeps first-seen order", () => {
		expect(
			skillNamesFromPrompt(`${chip("b")} then ${chip("a")} then ${chip("b")}`),
		).toEqual(["b", "a"]);
	});

	it("returns nothing for a prompt with no tokens", () => {
		expect(skillNamesFromPrompt("Summarize yesterday.")).toEqual([]);
		expect(skillNamesFromPrompt("")).toEqual([]);
	});
});

describe("assertPromptSkillTokensPinned", () => {
	it("accepts a chip whose skill is pinned", () => {
		expect(() =>
			assertPromptSkillTokensPinned(`Follow ${chip("deploy-runbook")}.`, [
				{ name: "deploy-runbook" },
			]),
		).not.toThrow();
	});

	it("rejects a chip with no pinned entry", () => {
		expect(() =>
			assertPromptSkillTokensPinned(`Follow ${chip("deploy-runbook")}.`, []),
		).toThrow(/deploy-runbook/);
	});

	it("names every unpinned skill, not just the first", () => {
		expect(() =>
			assertPromptSkillTokensPinned(`${chip("alpha")} ${chip("beta")}`, []),
		).toThrow(/"alpha", "beta"/);
	});

	it("rejects when only SOME chips are pinned", () => {
		// The realistic drift: the composer sent a stale skills array after the
		// author added one more chip.
		expect(() =>
			assertPromptSkillTokensPinned(`${chip("alpha")} ${chip("beta")}`, [
				{ name: "alpha" },
			]),
		).toThrow(/"beta"/);
	});

	it("allows a pinned skill that the prompt never mentions", () => {
		// The declarative path: `defineAutomation({ skills: [...] })` has no prompt.
		expect(() =>
			assertPromptSkillTokensPinned(null, [{ name: "deploy-runbook" }]),
		).not.toThrow();
		expect(() =>
			assertPromptSkillTokensPinned("Summarize yesterday.", [
				{ name: "deploy-runbook" },
			]),
		).not.toThrow();
	});

	it("is a no-op when there is neither a chip nor a pin", () => {
		expect(() => assertPromptSkillTokensPinned(undefined, undefined)).not.toThrow();
		expect(() => assertPromptSkillTokensPinned("", null)).not.toThrow();
	});

	it("matches on the skill name, not on label text that happens to collide", () => {
		// A chip labelled "alpha" whose actual skill id is "beta" must be checked
		// as "beta" — otherwise a rename shows green while pinning the wrong body.
		expect(() =>
			assertPromptSkillTokensPinned(`@[skill:beta:alpha](/x)`, [
				{ name: "alpha" },
			]),
		).toThrow(/"beta"/);
	});
});

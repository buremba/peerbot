import { describe, expect, it } from "vitest";
import {
	type ChannelVisibility,
	isConversationVisible,
} from "../../gateway/services/agent-thread-list";

/**
 * The team-scoped channel ACL for cross-platform conversation history. A Slack
 * channel id is only unique WITHIN a workspace, so the gate keys on
 * `{platform}:{team}:{channel}` and refuses to show a conversation it can't tie
 * to a single team — otherwise the same channel id in two workspaces would
 * collide and leak a transcript the requester can't read.
 */
function vis(opts: {
	visibleKeys: string[];
	channelTeams: Record<string, string[]>;
}): ChannelVisibility {
	return {
		visibleKeys: new Set(opts.visibleKeys),
		channelTeams: new Map(
			Object.entries(opts.channelTeams).map(([k, v]) => [k, new Set(v)]),
		),
	};
}

describe("isConversationVisible", () => {
	it("allows a conversation on a single-workspace, member-visible channel", () => {
		const v = vis({
			visibleKeys: ["slack:T1:C123"],
			channelTeams: { "slack:C123": ["T1"] },
		});
		expect(isConversationVisible("slack:C123:1781.0", v)).toBe(true);
	});

	it("fails closed when the channel id is bound in more than one workspace", () => {
		// Same channel id across two Slack teams — the conversation id carries no
		// team, so it must NOT show even though T1 is visible.
		const v = vis({
			visibleKeys: ["slack:T1:C123"],
			channelTeams: { "slack:C123": ["T1", "T2"] },
		});
		expect(isConversationVisible("slack:C123:1781.0", v)).toBe(false);
	});

	it("fails closed when the requester isn't a member of the channel's team", () => {
		const v = vis({
			visibleKeys: [],
			channelTeams: { "slack:C123": ["T2"] },
		});
		expect(isConversationVisible("slack:C123:1781.0", v)).toBe(false);
	});

	it("fails closed for an unbound channel", () => {
		const v = vis({
			visibleKeys: ["slack:T1:C123"],
			channelTeams: { "slack:C123": ["T1"] },
		});
		expect(isConversationVisible("slack:CSECRET:1781.0", v)).toBe(false);
	});

	it("handles teamless platforms (telegram) by channel", () => {
		const v = vis({
			visibleKeys: ["telegram::998877"],
			channelTeams: { "telegram:998877": [""] },
		});
		expect(isConversationVisible("telegram:998877:1", v)).toBe(true);
		expect(isConversationVisible("telegram:111:1", v)).toBe(false);
	});
});

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	__setBindChannelNotifyDepsForTests,
	channelBindConfirmationText,
	postChannelBindConfirmation,
} from "../bind-channel-notify";

const defaultDeps = {
	getManager: () => null,
	gatewayRunning: () => false,
};

afterEach(() => {
	__setBindChannelNotifyDepsForTests(defaultDeps);
});

describe("channelBindConfirmationText", () => {
	it("bolds the agent name when no dashboard URL is available", () => {
		expect(channelBindConfirmationText("Finance Bot")).toBe(
			"✅ Linked to **Finance Bot**. I'll reply here from now on.",
		);
	});

	it("links the agent name to the Behaviors page when a URL is set", () => {
		expect(
			channelBindConfirmationText(
				"Finance Bot",
				"https://app.lobu.ai/acme/agents/agent-1/behaviors",
			),
		).toBe(
			"✅ Linked to [Finance Bot](https://app.lobu.ai/acme/agents/agent-1/behaviors). I'll reply here from now on.",
		);
	});
});

describe("postChannelBindConfirmation", () => {
	it("skips when the channel was already bound to the same agent", async () => {
		const postMessageToChannel = mock(async () => {});
		__setBindChannelNotifyDepsForTests({
			gatewayRunning: () => true,
			getManager: () => ({ postMessageToChannel }),
		});

		await postChannelBindConfirmation({
			connectionSlug: "slackinst-test",
			platform: "slack",
			channelId: "slack:C111",
			agentId: "agent-a",
			agentName: "Agent A",
			previousAgentId: "agent-a",
		});

		expect(postMessageToChannel).not.toHaveBeenCalled();
	});

	it("skips when the gateway is not running", async () => {
		const postMessageToChannel = mock(async () => {});
		__setBindChannelNotifyDepsForTests({
			gatewayRunning: () => false,
			getManager: () => ({ postMessageToChannel }),
		});

		await postChannelBindConfirmation({
			connectionSlug: "slackinst-test",
			platform: "slack",
			channelId: "slack:C111",
			agentId: "agent-a",
			agentName: "Agent A",
		});

		expect(postMessageToChannel).not.toHaveBeenCalled();
	});

	it("posts via the chat instance manager on a new bind", async () => {
		const postMessageToChannel = mock(async () => {});
		__setBindChannelNotifyDepsForTests({
			gatewayRunning: () => true,
			getManager: () => ({ postMessageToChannel }),
		});

		await postChannelBindConfirmation({
			connectionSlug: "agentconn-42",
			platform: "telegram",
			channelId: "-100123",
			agentId: "agent-a",
			agentName: "Finance Bot",
			agentUrl: "https://app.lobu.ai/acme/agents/agent-a/behaviors",
		});

		expect(postMessageToChannel).toHaveBeenCalledTimes(1);
		expect(postMessageToChannel).toHaveBeenCalledWith(
			"42",
			"telegram:-100123",
			{
				markdown:
					"✅ Linked to [Finance Bot](https://app.lobu.ai/acme/agents/agent-a/behaviors). I'll reply here from now on.",
			},
		);
	});

	it("still posts when rebinding to a different agent", async () => {
		const postMessageToChannel = mock(async () => {});
		__setBindChannelNotifyDepsForTests({
			gatewayRunning: () => true,
			getManager: () => ({ postMessageToChannel }),
		});

		await postChannelBindConfirmation({
			connectionSlug: "slackinst-test",
			platform: "slack",
			channelId: "slack:C111",
			agentId: "agent-b",
			agentName: "Agent B",
			previousAgentId: "agent-a",
		});

		expect(postMessageToChannel).toHaveBeenCalledTimes(1);
	});
});
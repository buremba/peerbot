/**
 * Inbound dispatch must behave identically for every chat adapter.
 *
 * Chat SDK runs `messageHistory.append()` inside `handleIncomingMessage`
 * BEFORE `dispatchToHandlers`, guarded only by the adapter's
 * `persistMessageHistory` flag. Telegram and WhatsApp set that flag; Slack,
 * Discord, Teams and GChat do not. The append is unguarded, so any throw
 * inside it is caught by `processMessage` and the inbound message is discarded
 * even though the webhook still returns 200.
 *
 * That made a durable-history *cache* write able to drop a user's message, and
 * only on the two platforms that set the flag (prod: a Telegram DM returned 200
 * with no reply, while Slack on the same build was unaffected).
 *
 * Lobu already persists transcripts itself via `captureChannelMessage` →
 * `channel_messages`, which is platform-agnostic, idempotent and explicitly
 * fire-and-forget. Its live-history path also falls back to
 * `ConversationStateStore` for platforms without a history API, so the SDK
 * cache must never be able to block dispatch.
 *
 * These tests pin the regression and the production seam: an adapter that
 * would persist SDK history still dispatches when that store fails.
 */
import { describe, expect, test } from "bun:test";
import { Chat } from "chat";
import { disableSdkMessageHistory } from "../platforms/shared.js";

/** In-memory StateAdapter whose list ops fail, standing in for any store fault. */
function createStateAdapter(options: { failListAppend: boolean }) {
	return {
		async connect() {},
		async disconnect() {},
		async setIfNotExists() {
			return true;
		},
		async acquireLock(threadId: string) {
			return { threadId, token: "t", expiresAt: Date.now() + 60_000 };
		},
		async releaseLock() {},
		async isSubscribed() {
			return false;
		},
		async appendToList() {
			if (options.failListAppend) {
				throw new Error("history store unavailable");
			}
		},
	};
}

/** Minimal persisting adapter implementing the inbound surface under test. */
function createAdapter() {
	return {
		name: "test",
		userName: "lobubot",
		botUserId: "999",
		persistMessageHistory: true,
		async initialize() {},
		async shutdown() {},
		isDM: (threadId: string) => !threadId.includes(":group"),
		channelIdFromThreadId: (threadId: string) => threadId,
		getChannelVisibility: () => "private" as const,
		async postMessage() {
			return {} as Record<string, unknown>;
		},
		parseMessage: (raw: unknown) => raw,
	};
}

function createMessage(text: string) {
	return {
		id: "m1",
		text,
		author: {
			userId: "42",
			userName: "human",
			fullName: "Human",
			isBot: false,
			isMe: false,
		},
		isMention: false,
		metadata: {},
		toJSON: () => ({ id: "m1", text, raw: null }),
	};
}

/**
 * Drive one inbound DM through the real Chat SDK and report whether the
 * registered handler ran.
 */
async function dispatchOnce(params: {
	failListAppend: boolean;
	/** Skip the production seam, to show the raw SDK semantics it guards against. */
	rawSdk?: boolean;
}): Promise<string[]> {
	const delivered: string[] = [];
	const built = createAdapter();
	// Production wraps every adapter through this seam in createAdapter().
	const adapter = params.rawSdk ? built : disableSdkMessageHistory(built);
	const chat = new Chat({
		userName: "lobubot",
		adapters: { test: adapter as never },
		state: createStateAdapter({
			failListAppend: params.failListAppend,
		}) as never,
		logger: "silent",
	});
	chat.onDirectMessage(async (_thread: unknown, message: { text: string }) => {
		delivered.push(message.text);
	});
	await chat.initialize();
	let processing: Promise<void> | undefined;
	// Go through processMessage, exactly as an adapter's webhook handler does,
	// and capture its background task through the SDK's webhook completion hook.
	(
		chat as unknown as {
			processMessage: (
				a: unknown,
				t: string,
				m: unknown,
				options: { waitUntil(task: Promise<void>): void },
			) => void;
		}
	).processMessage(adapter, "test:dm-1", createMessage("hello"), {
		waitUntil(task) {
			processing = task;
		},
	});
	if (!processing) {
		throw new Error("Chat SDK did not register its background message task");
	}
	await processing;
	return delivered;
}

describe("Chat SDK message-history dispatch", () => {
	test("raw SDK dispatches when its history store is healthy", async () => {
		expect(
			await dispatchOnce({
				failListAppend: false,
				rawSdk: true,
			}),
		).toEqual(["hello"]);
	});

	test("a failing history store does not drop the message after normalization", async () => {
		expect(
			await dispatchOnce({
				failListAppend: true,
			}),
		).toEqual(["hello"]);
	});

	/**
	 * Pins WHY the seam exists. Without `disableSdkMessageHistory`, the SDK
	 * appends history before dispatching and a failing store swallows the
	 * message — the exact production symptom (webhook 200, no reply).
	 * If this ever starts delivering, the SDK fixed it upstream and the seam
	 * can go.
	 */
	test("raw SDK drops the message when history persistence fails", async () => {
		expect(
			await dispatchOnce({
				failListAppend: true,
				rawSdk: true,
			}),
		).toEqual([]);
	});
});

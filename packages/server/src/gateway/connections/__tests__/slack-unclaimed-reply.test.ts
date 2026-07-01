/**
 * `parseSlackUserMessageEvent` decides which incoming Slack webhook bodies are a
 * real user @mention or DM that the unclaimed-workspace path should reply to.
 * It must reply to app_mentions and direct messages, and stay silent for the
 * bot's own messages, edits/subtypes, channel chatter, challenges, and
 * non-event (slash/interactivity) payloads — otherwise the connect-link reply
 * would spam or loop.
 */

import { describe, expect, test } from "bun:test";
import { parseSlackUserMessageEvent } from "../slack-connection-coordinator.js";

const JSON_CT = "application/json";

function eventBody(event: Record<string, unknown>): string {
  return JSON.stringify({ type: "event_callback", team_id: "T1", event });
}

describe("parseSlackUserMessageEvent", () => {
  test("replies to an app_mention", () => {
    const body = eventBody({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      text: "<@B> hi",
    });
    expect(parseSlackUserMessageEvent(body, JSON_CT)).toEqual({
      channel: "C1",
      user: "U1",
    });
  });

  test("replies to a direct message (channel_type im)", () => {
    const body = eventBody({
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "hey",
    });
    expect(parseSlackUserMessageEvent(body, JSON_CT)).toEqual({
      channel: "D1",
      user: "U1",
    });
  });

  test("ignores a plain channel message (not a mention, not a DM)", () => {
    const body = eventBody({
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "chatter",
    });
    expect(parseSlackUserMessageEvent(body, JSON_CT)).toBeNull();
  });

  test("ignores the bot's own message (bot_id present)", () => {
    const body = eventBody({
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      bot_id: "B999",
      text: "my own reply",
    });
    expect(parseSlackUserMessageEvent(body, JSON_CT)).toBeNull();
  });

  test("ignores a message edit/subtype in a DM", () => {
    const body = eventBody({
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      subtype: "message_changed",
      text: "edited",
    });
    expect(parseSlackUserMessageEvent(body, JSON_CT)).toBeNull();
  });

  test("ignores an event missing channel or user", () => {
    expect(
      parseSlackUserMessageEvent(
        eventBody({ type: "app_mention", user: "U1" }),
        JSON_CT,
      ),
    ).toBeNull();
    expect(
      parseSlackUserMessageEvent(
        eventBody({ type: "app_mention", channel: "C1" }),
        JSON_CT,
      ),
    ).toBeNull();
  });

  test("ignores a url_verification challenge", () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    expect(parseSlackUserMessageEvent(body, JSON_CT)).toBeNull();
  });

  test("ignores a non-event_callback envelope", () => {
    const body = JSON.stringify({
      type: "something_else",
      event: { type: "app_mention", channel: "C1", user: "U1" },
    });
    expect(parseSlackUserMessageEvent(body, JSON_CT)).toBeNull();
  });

  test("ignores form-encoded (slash/interactivity) bodies", () => {
    expect(
      parseSlackUserMessageEvent(
        "payload=%7B%7D",
        "application/x-www-form-urlencoded",
      ),
    ).toBeNull();
  });

  test("ignores non-JSON bodies", () => {
    expect(parseSlackUserMessageEvent("not json", JSON_CT)).toBeNull();
  });
});

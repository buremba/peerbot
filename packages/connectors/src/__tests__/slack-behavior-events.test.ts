import { describe, expect, test } from 'bun:test';
import { SLACK_BEHAVIOR_EVENTS } from '../slack-behavior-events';

describe('Slack Behavior events', () => {
  test('advertises message activation with the live chat policy', () => {
    expect(SLACK_BEHAVIOR_EVENTS).toContainEqual(
      expect.objectContaining({
        key: 'message.created',
        capabilities: { steering: true, replyToSource: true },
        defaults: {
          execution: 'turn',
          activeRun: 'steer',
          output: 'reply_to_source',
        },
      }),
    );
  });
});

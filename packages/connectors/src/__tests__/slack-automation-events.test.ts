import { describe, expect, test } from 'bun:test';
import { SLACK_AUTOMATION_EVENTS } from '../slack-automation-events';

describe('Slack Automation events', () => {
  test('advertises message activation with the live chat policy', () => {
    expect(SLACK_AUTOMATION_EVENTS).toContainEqual(
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

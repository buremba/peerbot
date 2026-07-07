import { describe, expect, it } from 'vitest';
import {
  normalizeSlackIdentityValue,
  normalizeSlackUserId,
  SLACK_IDENTITY,
  slackAclSource,
  slackChannelKey,
  slackChannelsToResources,
} from '../slack-identity.js';

describe('normalizeSlackUserId', () => {
  it('combines team and user id into TEAM:USER form, uppercase', () => {
    expect(normalizeSlackUserId('T0abc', 'u123')).toBe('T0ABC:U123');
    expect(normalizeSlackUserId(' T0ABC ', ' U123 ')).toBe('T0ABC:U123');
  });

  it('rejects missing or malformed parts', () => {
    expect(normalizeSlackUserId(null, 'U123')).toBeNull();
    expect(normalizeSlackUserId('T0ABC', null)).toBeNull();
    expect(normalizeSlackUserId('T0 space', 'U123')).toBeNull();
    expect(normalizeSlackUserId('T0ABC', '')).toBeNull();
  });
});

describe('normalizeSlackIdentityValue', () => {
  it('canonicalizes an already-combined TEAM:USER value for both slack namespaces', () => {
    expect(normalizeSlackIdentityValue(SLACK_IDENTITY.USER_ID, 'T0abc:u123')).toBe('T0ABC:U123');
    expect(normalizeSlackIdentityValue(SLACK_IDENTITY.CHANNEL_ID, ' T0ABC:C99 ')).toBe('T0ABC:C99');
  });

  it('rejects values without a team prefix or with malformed parts', () => {
    expect(normalizeSlackIdentityValue(SLACK_IDENTITY.USER_ID, 'U123')).toBeNull();
    expect(normalizeSlackIdentityValue(SLACK_IDENTITY.USER_ID, ':U123')).toBeNull();
    expect(normalizeSlackIdentityValue(SLACK_IDENTITY.USER_ID, 'T0ABC:')).toBeNull();
  });

  it('returns undefined ("not mine") for a non-Slack namespace', () => {
    expect(normalizeSlackIdentityValue('email', 'a@b.com')).toBeUndefined();
    expect(normalizeSlackIdentityValue('github_login', 'octocat')).toBeUndefined();
  });
});

describe('slackChannelKey', () => {
  it('team-scopes + uppercases', () => {
    expect(slackChannelKey('t0abc', 'c01eng')).toBe('T0ABC:C01ENG');
    expect(slackChannelKey(' T0ABC ', ' C01ENG ')).toBe('T0ABC:C01ENG');
  });
});

describe('slackAclSource', () => {
  it('declares the channel resource keyed on slack_channel_id with slack_user_id members', () => {
    expect(slackAclSource.key).toBe('slack');
    expect(slackAclSource.resourceType.slug).toBe('channel');
    expect(slackAclSource.resourceType.namespace).toBe(SLACK_IDENTITY.CHANNEL_ID);
    expect(slackAclSource.memberIdentities).toEqual([
      { namespace: SLACK_IDENTITY.USER_ID, primary: true },
    ]);
  });
});

describe('slackChannelsToResources', () => {
  it('team-scopes channels and resolves members on the canonical slack_user_id', () => {
    const resources = slackChannelsToResources('T0ABC', [
      { channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U1', 'U2'] },
      { channelId: 'C01SEC', memberSlackUserIds: ['U1'] },
    ]);
    expect(resources.map((r) => r.key)).toEqual(['T0ABC:C01ENG', 'T0ABC:C01SEC']);
    expect(resources[0].members.map((m) => m.identities[0].value)).toEqual([
      'T0ABC:U1',
      'T0ABC:U2',
    ]);
    expect(resources[0].members[0].identities[0].namespace).toBe(SLACK_IDENTITY.USER_ID);
  });

  it('drops channels without an id and members that do not team-scope', () => {
    const resources = slackChannelsToResources('T0ABC', [
      { channelId: '', memberSlackUserIds: ['U1'] },
      { channelId: 'C01ENG', memberSlackUserIds: ['U1', ''] },
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0].members).toHaveLength(1);
  });
});

import {
  normalizeAuthUserId,
  normalizeEmail,
  normalizeIdentifier,
  normalizeNumericId,
  normalizePhone,
  normalizeSlackUserId,
  normalizeSlackUserIdCombined,
  normalizeWaJid,
} from '@lobu/connector-sdk/identity-normalize';
import { describe, expect, it } from 'vitest';

describe('normalizePhone', () => {
  it('strips non-digit characters and returns the digit-only string', () => {
    expect(normalizePhone('+1 (415) 555-1234')).toBe('14155551234');
    expect(normalizePhone('1-415-555-1234')).toBe('14155551234');
    expect(normalizePhone('14155551234')).toBe('14155551234');
    expect(normalizePhone('  +14155551234  ')).toBe('14155551234');
  });

  it('rejects values outside the E.164 digit range', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('1234567890123456')).toBeNull();
    expect(normalizePhone('not-a-phone')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims valid email addresses', () => {
    expect(normalizeEmail('  Emr.E@Rakam.io ')).toBe('emr.e@rakam.io');
    expect(normalizeEmail('user@example.com')).toBe('user@example.com');
  });

  it('rejects malformed emails', () => {
    expect(normalizeEmail('no-at-sign')).toBeNull();
    expect(normalizeEmail('@missing-local.com')).toBeNull();
    expect(normalizeEmail('missing-domain@')).toBeNull();
    expect(normalizeEmail('missing-tld@example')).toBeNull();
    expect(normalizeEmail('double@@at.com')).toBeNull();
    expect(normalizeEmail('spaces in@email.com')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe('normalizeWaJid', () => {
  it('accepts the recognized JID suffixes and lowercases them', () => {
    expect(normalizeWaJid('14155551234@s.whatsapp.net')).toBe('14155551234@s.whatsapp.net');
    expect(normalizeWaJid('  14155551234@S.WhatsApp.Net  ')).toBe('14155551234@s.whatsapp.net');
    expect(normalizeWaJid('123456@lid')).toBe('123456@lid');
    expect(normalizeWaJid('abc-xyz@g.us')).toBe('abc-xyz@g.us');
    expect(normalizeWaJid('999@broadcast')).toBe('999@broadcast');
    expect(normalizeWaJid('abc@newsletter')).toBe('abc@newsletter');
  });

  it('collapses multi-device JIDs so the same person on phone + linked devices hashes to one identity', () => {
    expect(normalizeWaJid('14155551234:5@s.whatsapp.net')).toBe('14155551234@s.whatsapp.net');
    expect(normalizeWaJid('442071234567:12@s.whatsapp.net')).toBe('442071234567@s.whatsapp.net');
    expect(normalizeWaJid('abc123:3@lid')).toBe('abc123@lid');
  });

  it('rejects values without a recognized suffix', () => {
    expect(normalizeWaJid('14155551234@whatsapp.com')).toBeNull();
    expect(normalizeWaJid('plain-string')).toBeNull();
    expect(normalizeWaJid('')).toBeNull();
    expect(normalizeWaJid(null)).toBeNull();
  });
});

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

describe('normalizeSlackUserIdCombined', () => {
  it('canonicalizes an already-combined TEAM:USER value, uppercase', () => {
    expect(normalizeSlackUserIdCombined('T0abc:u123')).toBe('T0ABC:U123');
    expect(normalizeSlackUserIdCombined(' T0ABC:U123 ')).toBe('T0ABC:U123');
  });

  it('rejects values without a team prefix or with malformed parts', () => {
    expect(normalizeSlackUserIdCombined('U123')).toBeNull();
    expect(normalizeSlackUserIdCombined(':U123')).toBeNull();
    expect(normalizeSlackUserIdCombined('T0ABC:')).toBeNull();
    expect(normalizeSlackUserIdCombined('T0 space:U123')).toBeNull();
    expect(normalizeSlackUserIdCombined('')).toBeNull();
    expect(normalizeSlackUserIdCombined(null)).toBeNull();
  });
});

describe('normalizeNumericId', () => {
  it('normalizes positive numeric ids', () => {
    expect(normalizeNumericId('82745')).toBe('82745');
    expect(normalizeNumericId('  00123  ')).toBe('123');
  });

  it('rejects non-numeric ids', () => {
    expect(normalizeNumericId('abc')).toBeNull();
    expect(normalizeNumericId('12.3')).toBeNull();
    expect(normalizeNumericId('')).toBeNull();
  });
});

describe('normalizeAuthUserId', () => {
  it('trims but preserves case to match Better Auth ids', () => {
    expect(normalizeAuthUserId('  abc123 ')).toBe('abc123');
    expect(normalizeAuthUserId('ABC123')).toBe('ABC123');
  });

  it('rejects empty or non-string', () => {
    expect(normalizeAuthUserId('')).toBeNull();
    expect(normalizeAuthUserId(null)).toBeNull();
  });
});

describe('normalizeIdentifier dispatcher', () => {
  it('dispatches generic cross-channel namespaces', () => {
    expect(normalizeIdentifier('phone', '+1 (415) 555-1234')).toBe('14155551234');
    expect(normalizeIdentifier('email', 'Foo@Bar.COM')).toBe('foo@bar.com');
    expect(normalizeIdentifier('auth_user_id', '  abc123 ')).toBe('abc123');
  });

  it('preserves legacy trim-only behavior for existing connector namespaces until backfill', () => {
    expect(normalizeIdentifier('wa_jid', '14155551234@S.WhatsApp.Net')).toBe(
      '14155551234@S.WhatsApp.Net'
    );
    expect(normalizeIdentifier('github_login', 'Octocat')).toBe('Octocat');
    expect(normalizeIdentifier('slack_user_id', 't0abc:u123')).toBe('t0abc:u123');
  });

  it('dispatches newly registered X namespaces', () => {
    expect(normalizeIdentifier('x_user_id', '00123')).toBe('123');
    expect(normalizeIdentifier('x_handle', '@Alice')).toBe('alice');
  });

  it('falls back to trim-only for unknown namespaces so custom identities still get hygiene', () => {
    expect(normalizeIdentifier('stripe_customer_id', '  cus_abc  ')).toBe('cus_abc');
    expect(normalizeIdentifier('custom', '')).toBeNull();
  });
});
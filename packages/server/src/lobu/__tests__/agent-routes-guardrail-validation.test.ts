/**
 * Unit coverage for `validateGuardrailsInline` — the write-boundary validation
 * that protects the guardrail aggregator from malformed `guardrailsInline` rows.
 * An entry with an invalid `stage` (or missing name/policy) would otherwise be
 * persisted verbatim and then crash the aggregator mid-message when it indexes
 * `seen[stage]`. The PATCH `/:agentId/config` route rejects such payloads (400).
 */

import { describe, expect, test } from 'bun:test';
import { validateGuardrailsInline } from '../agent-routes.js';

describe('validateGuardrailsInline', () => {
  test('returns null for an absent payload', () => {
    expect(validateGuardrailsInline(undefined)).toBeNull();
  });

  test('returns null for an empty array', () => {
    expect(validateGuardrailsInline([])).toBeNull();
  });

  test('accepts a fully-valid inline guardrail', () => {
    expect(
      validateGuardrailsInline([
        {
          name: 'tone-check',
          enabled: true,
          stage: 'output',
          policy: 'no profanity',
          model: 'anthropic/claude-haiku-4-5',
          tools: ['bash'],
        },
      ])
    ).toBeNull();
  });

  test('rejects a non-array payload', () => {
    expect(validateGuardrailsInline({})).toMatch(/must be an array/);
  });

  test('rejects an invalid stage — the crash vector', () => {
    const err = validateGuardrailsInline([
      { name: 'bad', enabled: true, stage: 'outupt', policy: 'x' },
    ]);
    expect(err).toMatch(/stage must be one of/);
  });

  test('rejects a missing/blank name', () => {
    expect(
      validateGuardrailsInline([
        { name: '   ', enabled: true, stage: 'input', policy: 'x' },
      ])
    ).toMatch(/name must be a non-empty string/);
  });

  test('rejects a non-boolean enabled', () => {
    expect(
      validateGuardrailsInline([
        { name: 'g', enabled: 'yes', stage: 'input', policy: 'x' },
      ])
    ).toMatch(/enabled must be a boolean/);
  });

  test('rejects a blank policy', () => {
    expect(
      validateGuardrailsInline([
        { name: 'g', enabled: true, stage: 'input', policy: '' },
      ])
    ).toMatch(/policy must be a non-empty string/);
  });

  test('rejects a non-string model', () => {
    expect(
      validateGuardrailsInline([
        { name: 'g', enabled: true, stage: 'input', policy: 'x', model: 42 },
      ])
    ).toMatch(/model must be a string/);
  });

  test('rejects tools that are not a string array', () => {
    expect(
      validateGuardrailsInline([
        { name: 'g', enabled: true, stage: 'input', policy: 'x', tools: [1] },
      ])
    ).toMatch(/tools must be an array of strings/);
  });
});

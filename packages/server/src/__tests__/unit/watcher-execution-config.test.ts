/**
 * Unit coverage for execution_config validation + the owner/admin gate on
 * elevated permission modes. The end-to-end persistence/round-trip is covered
 * in __tests__/integration/watchers/watchers-crud.test.ts; this pins the
 * validation rules and the privilege gate without the integration harness.
 */

import { describe, expect, it } from 'bun:test';
import {
  assertValidExecutionConfig,
  type ExecutionConfigCaller,
} from '../../tools/admin/watcher-execution-config';

const owner: ExecutionConfigCaller = { memberRole: 'owner', userId: 'u1', isAuthenticated: true };
const admin: ExecutionConfigCaller = { memberRole: 'admin', userId: 'u2', isAuthenticated: true };
const member: ExecutionConfigCaller = { memberRole: 'member', userId: 'u3', isAuthenticated: true };
// apply / automation / default-provisioning: authenticated, no user/role.
const system: ExecutionConfigCaller = { memberRole: null, userId: null, isAuthenticated: true };

describe('assertValidExecutionConfig — passthrough', () => {
  it('accepts undefined (unchanged) and null (clear)', () => {
    expect(() => assertValidExecutionConfig(undefined, member)).not.toThrow();
    expect(() => assertValidExecutionConfig(null, member)).not.toThrow();
  });

  it('accepts a valid full config', () => {
    expect(() =>
      assertValidExecutionConfig(
        {
          timeout_seconds: 1800,
          max_budget_usd: 2.5,
          model: 'opus',
          permission_mode: 'plan',
          effort: 'high',
        },
        owner
      )
    ).not.toThrow();
  });
});

describe('assertValidExecutionConfig — schema validation', () => {
  it('rejects a non-object', () => {
    expect(() => assertValidExecutionConfig('nope', owner)).toThrow(/must be a JSON object/i);
    expect(() => assertValidExecutionConfig([1, 2], owner)).toThrow(/must be a JSON object/i);
  });

  it('rejects out-of-range timeout_seconds', () => {
    expect(() => assertValidExecutionConfig({ timeout_seconds: 0 }, owner)).toThrow(
      /execution_config/i
    );
    expect(() => assertValidExecutionConfig({ timeout_seconds: 999_999 }, owner)).toThrow(
      /execution_config/i
    );
  });

  it('rejects a wrong-typed field (string where integer expected)', () => {
    // This is the silent-brick case: an unvalidated string would fail the
    // device-worker's strict payload decode and disable every run.
    expect(() => assertValidExecutionConfig({ timeout_seconds: '600' }, owner)).toThrow(
      /execution_config/i
    );
  });

  it('rejects unknown keys (additionalProperties: false)', () => {
    expect(() => assertValidExecutionConfig({ bogus: true }, owner)).toThrow(/execution_config/i);
  });

  it('rejects an invalid permission_mode enum value', () => {
    expect(() => assertValidExecutionConfig({ permission_mode: 'yolo' }, owner)).toThrow(
      /execution_config/i
    );
  });
});

describe('assertValidExecutionConfig — elevated permission_mode gate', () => {
  for (const mode of ['bypassPermissions', 'dontAsk']) {
    it(`blocks a member from setting ${mode}`, () => {
      expect(() => assertValidExecutionConfig({ permission_mode: mode }, member)).toThrow(
        /owner or admin/i
      );
    });
    it(`allows an owner to set ${mode}`, () => {
      expect(() => assertValidExecutionConfig({ permission_mode: mode }, owner)).not.toThrow();
    });
    it(`allows an admin to set ${mode}`, () => {
      expect(() => assertValidExecutionConfig({ permission_mode: mode }, admin)).not.toThrow();
    });
    it(`allows a system/internal caller to set ${mode}`, () => {
      expect(() => assertValidExecutionConfig({ permission_mode: mode }, system)).not.toThrow();
    });
  }

  it('allows a member to set non-elevated modes', () => {
    for (const mode of ['default', 'plan', 'auto', 'acceptEdits']) {
      expect(() => assertValidExecutionConfig({ permission_mode: mode }, member)).not.toThrow();
    }
  });
});

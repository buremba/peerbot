/**
 * Unit coverage for execution_config validation + the owner/admin gate on
 * elevated permission modes. The end-to-end persistence/round-trip is covered
 * in __tests__/integration/automations/automations-crud.test.ts; this pins the
 * validation rules and the privilege gate without the integration harness.
 *
 * Shape/type/range validation moved to the tool boundary (lobu#1137):
 * AutomationExecutionConfigSchema is embedded in ManageAutomationsSchema, and
 * `withValidatedArgs` enforces it before the handler runs. The schema tests
 * below therefore go through `validateToolArgs` with the full tool schema —
 * the same path a real manage_automations call takes — while the role-policy
 * gate stays on `assertValidExecutionConfig`.
 */

import { describe, expect, it } from 'bun:test';
import { ManageAutomationsSchema } from '../../tools/admin/manage_automations';
import {
  assertServerLaneModelResolves,
  assertValidExecutionConfig,
  type ExecutionConfigCaller,
} from '../../tools/admin/automation-execution-config';
import { validateToolArgs } from '../../tools/validate-args';
import { ToolUserError } from '../../utils/errors';

function validateUpdateWith(executionConfig: unknown): unknown {
  return validateToolArgs('manage_automations', ManageAutomationsSchema, {
    action: 'update',
    automation_id: '1',
    execution_config: executionConfig,
  });
}

const owner: ExecutionConfigCaller = { memberRole: 'owner', userId: 'u1', isAuthenticated: true };
const admin: ExecutionConfigCaller = { memberRole: 'admin', userId: 'u2', isAuthenticated: true };
const member: ExecutionConfigCaller = { memberRole: 'member', userId: 'u3', isAuthenticated: true };
// apply / automation: authenticated, no user/role.
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

describe('execution_config boundary validation (via ManageAutomationsSchema)', () => {
  it('rejects a non-object', () => {
    expect(() => validateUpdateWith('nope')).toThrow(ToolUserError);
    expect(() => validateUpdateWith([1, 2])).toThrow(ToolUserError);
  });

  it('rejects out-of-range timeout_seconds', () => {
    expect(() => validateUpdateWith({ timeout_seconds: 0 })).toThrow(/execution_config/i);
    expect(() => validateUpdateWith({ timeout_seconds: 999_999 })).toThrow(/execution_config/i);
  });

  it('coerces a numeric string timeout to an integer (silent-brick case)', () => {
    // An unvalidated string would fail the device-worker's strict payload
    // decode and disable every run. The boundary coerces '600' → 600, so the
    // persisted value is a well-typed integer; a non-numeric string rejects.
    const out = validateUpdateWith({ timeout_seconds: '600' }) as {
      execution_config: { timeout_seconds: number };
    };
    expect(out.execution_config.timeout_seconds).toBe(600);
    expect(() => validateUpdateWith({ timeout_seconds: 'abc' })).toThrow(/execution_config/i);
  });

  it('rejects unknown keys (additionalProperties: false)', () => {
    expect(() => validateUpdateWith({ bogus: true })).toThrow(/execution_config/i);
  });

  it('rejects an invalid permission_mode enum value', () => {
    expect(() => validateUpdateWith({ permission_mode: 'yolo' })).toThrow(/execution_config/i);
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

/**
 * `lobu apply` writes Automations at phase 6 and org-owned inference providers
 * at phase 10b, so a config declaring BOTH a provider and an Automation pinned
 * to that provider's model reaches the model guard four phases before the
 * provider row exists. The guard must stand down for an apply run rather than
 * reject a config that is internally consistent — and do it before touching the
 * database, since there is nothing to look up yet.
 */
describe('assertServerLaneModelResolves — lobu apply exemption', () => {
  const applyRun = {
    executionConfig: { model: 'not-registered-yet/some-model' },
    organizationId: 'org_apply',
    isDevicePinned: false,
  };

  it('stands down for an apply run (no provider lookup, no throw)', async () => {
    await expect(
      assertServerLaneModelResolves({ ...applyRun, applyId: 'apply_abc123' })
    ).resolves.toBeUndefined();
  });

  it('reaches the provider lookup off an apply run', async () => {
    // Asserts the DB-less failure BY NAME, not a bare `toThrow()`: the point is
    // that this call gets as far as the provider lookup, which is exactly what
    // the apply arm above short-circuits past. The real rejection (a
    // ToolUserError naming the unregistered slug) is covered against a live
    // database in integration/automations/automation-model-namespace.test.ts.
    await expect(
      assertServerLaneModelResolves({ ...applyRun, applyId: null })
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it('skips a device-pinned Automation without a lookup', async () => {
    await expect(
      assertServerLaneModelResolves({
        ...applyRun,
        isDevicePinned: true,
        applyId: null,
      })
    ).resolves.toBeUndefined();
  });

  it.each(['auto', 'bare-model-id', ''])(
    "does not second-guess %o",
    async (model) => {
      await expect(
        assertServerLaneModelResolves({
          executionConfig: { model },
          organizationId: 'org_apply',
          isDevicePinned: false,
          applyId: null,
        })
      ).resolves.toBeUndefined();
    }
  );
});

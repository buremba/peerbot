/**
 * Manage Actions Integration Tests
 *
 * Tests for listing available actions, executing with approval mode,
 * listing runs, approving, and rejecting.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestActionRun,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Manage Actions', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let connection: Awaited<ReturnType<typeof createTestConnection>>;
  let inactiveConnection: Awaited<ReturnType<typeof createTestConnection>>;

  const actionsSchema = {
    send_email: {
      name: 'Send Email',
      description: 'Send an email notification',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    send_important_email: {
      name: 'Send Important Email',
      description: 'Send an important email requiring approval',
      requiresApproval: true,
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
  };

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const sql = getTestDb();

    org = await createTestOrganization({ name: 'Actions Test Org' });
    user = await createTestUser({ email: 'actions-user@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    entity = await createTestEntity({ name: 'Actions Entity', organization_id: org.id });

    await createTestConnectorDefinition({
      key: 'test-actions-connector',
      name: 'Test Actions Connector',
      organization_id: org.id,
    });

    // Add actions_schema to the connector definition
    await sql`
      UPDATE connector_definitions
      SET actions_schema = ${sql.json(actionsSchema)}
      WHERE key = 'test-actions-connector'
    `;

    // Connector without actions
    await createTestConnectorDefinition({
      key: 'test-no-actions-connector',
      name: 'No Actions Connector',
      organization_id: org.id,
    });

    connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test-actions-connector',
      entity_ids: [entity.id],
      status: 'active',
    });

    inactiveConnection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test-actions-connector',
      entity_ids: [entity.id],
      status: 'paused',
    });
  });

  describe('list_available', () => {
    it('should return operations from connectors with actions_schema', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        { action: 'list_available' },
        { token }
      );
      expect(result.operations).toBeDefined();
      expect(result.operations.length).toBeGreaterThanOrEqual(1);
      const emailAction = result.operations.find((a: any) => a.operation_key === 'send_email');
      expect(emailAction).toBeDefined();
    });

    it('should filter by connector_key', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        { action: 'list_available', connector_key: 'test-no-actions-connector' },
        { token }
      );
      expect(result.operations).toBeDefined();
      expect(result.operations.length).toBe(0);
    });
  });

  describe('execute inline (E2E subprocess)', () => {
    beforeAll(async () => {
      const sql = getTestDb();
      // Replace dummy compiled_code with a real connector that has execute()
      const compiledCode = `
export class TestActionConnector {
  sync() { return { events: [], checkpoint: null }; }
  execute(ctx) {
    if (ctx.actionKey === 'send_email') {
      return { success: true, output: { sent: true, to: ctx.input.to, subject: ctx.input.subject } };
    }
    return { success: false, error: 'Unknown action: ' + ctx.actionKey };
  }
}`;
      await sql`
        UPDATE connector_versions
        SET compiled_code = ${compiledCode}
        WHERE connector_key = 'test-actions-connector'
      `;
    });

    it('should execute action inline and return completed result', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        {
          action: 'execute',
          connection_id: connection.id,
          operation_key: 'send_email',
          input: { to: 'e2e@test.com', subject: 'E2E Test' },
        },
        { token }
      );
      expect(result.status).toBe('completed');
      expect(result.run_id).toBeDefined();
      expect(result.output).toEqual({
        sent: true,
        to: 'e2e@test.com',
        subject: 'E2E Test',
      });
    });

    it('should persist completed run in database', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        {
          action: 'execute',
          connection_id: connection.id,
          operation_key: 'send_email',
          input: { to: 'db@test.com', subject: 'DB Check' },
        },
        { token }
      );
      expect(result.status).toBe('completed');

      // Verify the run was persisted
      const runs = await mcpToolsCall(
        'manage_operations',
        { action: 'list_runs', connection_id: connection.id, status: 'completed' },
        { token }
      );
      const run = runs.runs.find((r: any) => r.id === result.run_id);
      expect(run).toBeDefined();
      expect(run.operation_key).toBe('send_email');
      expect(run.status).toBe('completed');
      expect(run.output).toEqual({
        sent: true,
        to: 'db@test.com',
        subject: 'DB Check',
      });
    });

    it('should fail inline for invalid operation_key', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        {
          action: 'execute',
          connection_id: connection.id,
          operation_key: 'nonexistent_action',
          input: {},
        },
        { token }
      );
      expect(result.error).toMatch(/Invalid operation_key/);
    });

    it('should handle connector execute() returning failure', async () => {
      const sql = getTestDb();
      // Add a bogus action to the schema so validation passes, but connector returns failure
      const extendedSchema = {
        ...actionsSchema,
        unsupported_action: {
          name: 'Unsupported',
          description: 'Action the connector does not handle',
          input_schema: { type: 'object', properties: {} },
        },
      };
      await sql`
        UPDATE connector_definitions
        SET actions_schema = ${sql.json(extendedSchema)}
        WHERE key = 'test-actions-connector'
      `;

      const result = await mcpToolsCall(
        'manage_operations',
        {
          action: 'execute',
          connection_id: connection.id,
          operation_key: 'unsupported_action',
          input: {},
        },
        { token }
      );
      expect(result.status).toBe('failed');
      expect(result.error_message).toMatch(/Unknown action/);

      // Restore original schema
      await sql`
        UPDATE connector_definitions
        SET actions_schema = ${sql.json(actionsSchema)}
        WHERE key = 'test-actions-connector'
      `;
    });
  });

  describe('execute', () => {
    it('should return pending_approval for operations requiring approval', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        {
          action: 'execute',
          connection_id: connection.id,
          operation_key: 'send_important_email',
          input: { to: 'test@test.com', subject: 'Hi', body: 'Hello' },
        },
        { token }
      );
      expect(result.status).toBe('pending_approval');
      expect(result.run_id).toBeDefined();
    });

    it('should reject nonexistent connection', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        {
          action: 'execute',
          connection_id: 999999,
          operation_key: 'send_email',
          input: {},
        },
        { token }
      );
      expect(result.error).toBeDefined();
    });

    it('should reject inactive connection', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        {
          action: 'execute',
          connection_id: inactiveConnection.id,
          operation_key: 'send_email',
          input: {},
        },
        { token }
      );
      expect(result.error).toBeDefined();
    });
  });

  describe('list_runs', () => {
    beforeAll(async () => {
      await createTestActionRun({
        connection_id: connection.id,
        organization_id: org.id,
        action_key: 'send_email',
        status: 'pending',
        approval_status: 'pending',
      });
    });

    it('should list all runs', async () => {
      const result = await mcpToolsCall('manage_operations', { action: 'list_runs' }, { token });
      expect(result.runs).toBeDefined();
      expect(result.runs.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter by connection_id', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        { action: 'list_runs', connection_id: connection.id },
        { token }
      );
      expect(result.runs).toBeDefined();
      for (const run of result.runs) {
        expect(Number(run.connection_id)).toBe(connection.id);
      }
    });

    it('should filter by status', async () => {
      const result = await mcpToolsCall(
        'manage_operations',
        { action: 'list_runs', status: 'pending' },
        { token }
      );
      expect(result.runs).toBeDefined();
      for (const run of result.runs) {
        expect(run.status).toBe('pending');
      }
    });
  });

  describe('approve & reject', () => {
    it('should approve a pending run', async () => {
      const run = await createTestActionRun({
        connection_id: connection.id,
        organization_id: org.id,
        action_key: 'send_email',
        status: 'pending',
        approval_status: 'pending',
      });

      const result = await mcpToolsCall(
        'manage_operations',
        { action: 'approve', run_id: run.id },
        { token }
      );
      expect(result.approved).toBe(true);
    });

    it('should reject approving a non-pending run', async () => {
      const run = await createTestActionRun({
        connection_id: connection.id,
        organization_id: org.id,
        action_key: 'send_email',
        status: 'completed',
        approval_status: 'approved',
      });

      const result = await mcpToolsCall(
        'manage_operations',
        { action: 'approve', run_id: run.id },
        { token }
      );
      expect(result.error).toBeDefined();
    });

    it('should reject a pending run with reason', async () => {
      const run = await createTestActionRun({
        connection_id: connection.id,
        organization_id: org.id,
        action_key: 'send_email',
        status: 'pending',
        approval_status: 'pending',
      });

      const result = await mcpToolsCall(
        'manage_operations',
        { action: 'reject', run_id: run.id, reason: 'Not needed' },
        { token }
      );
      expect(result.rejected).toBe(true);
    });

    it('should reject rejecting a non-pending run', async () => {
      const run = await createTestActionRun({
        connection_id: connection.id,
        organization_id: org.id,
        action_key: 'send_email',
        status: 'completed',
        approval_status: 'approved',
      });

      const result = await mcpToolsCall(
        'manage_operations',
        { action: 'reject', run_id: run.id },
        { token }
      );
      expect(result.error).toBeDefined();
    });
  });
});

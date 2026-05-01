/**
 * Reusable workspace scenario builder for integration tests.
 *
 * Prefer this over hand-rolling org/user/client setup in each file. It keeps
 * role fixtures consistent while still letting tests choose the layer they are
 * exercising (`TestApiClient` for direct handlers, `TestMcpClient` for wire).
 */

import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  type TestOrganization,
  type TestUser,
} from './test-fixtures';
import { TestApiClient, type TestClientAuth } from './test-mcp-client';

export type TestWorkspaceRole = 'owner' | 'admin' | 'member';

type RoleClients = Record<TestWorkspaceRole, TestApiClient>;
type RoleUsers = Record<TestWorkspaceRole, TestUser>;

export class TestWorkspace {
  private constructor(
    readonly org: TestOrganization,
    readonly users: RoleUsers,
    private readonly clients: RoleClients
  ) {}

  static async create(options: {
    name?: string;
    slug?: string;
    visibility?: 'public' | 'private';
  } = {}): Promise<TestWorkspace> {
    const org = await createTestOrganization({
      name: options.name,
      slug: options.slug,
      visibility: options.visibility,
    });

    const users: RoleUsers = {
      owner: await createTestUser(),
      admin: await createTestUser(),
      member: await createTestUser(),
    };

    await addUserToOrganization(users.owner.id, org.id, 'owner');
    await addUserToOrganization(users.admin.id, org.id, 'admin');
    await addUserToOrganization(users.member.id, org.id, 'member');

    const clients: RoleClients = {
      owner: await TestApiClient.for(TestWorkspace.authFor(org.id, users.owner.id, 'owner')),
      admin: await TestApiClient.for(TestWorkspace.authFor(org.id, users.admin.id, 'admin')),
      member: await TestApiClient.for(TestWorkspace.authFor(org.id, users.member.id, 'member')),
    };

    return new TestWorkspace(org, users, clients);
  }

  static async pair(): Promise<{ a: TestWorkspace; b: TestWorkspace }> {
    const a = await TestWorkspace.create({ name: 'Contract Org A' });
    const b = await TestWorkspace.create({ name: 'Contract Org B' });
    return { a, b };
  }

  get owner(): TestApiClient {
    return this.clients.owner;
  }

  get admin(): TestApiClient {
    return this.clients.admin;
  }

  get member(): TestApiClient {
    return this.clients.member;
  }

  client(role: TestWorkspaceRole): TestApiClient {
    return this.clients[role];
  }

  asAnonymous(): TestApiClient {
    return this.owner.withAuth({ userId: null, memberRole: null, tokenType: 'anonymous' });
  }

  withAuth(overrides: Partial<TestClientAuth>): TestApiClient {
    return this.owner.withAuth(overrides);
  }

  private static authFor(
    organizationId: string,
    userId: string,
    memberRole: TestWorkspaceRole
  ): TestClientAuth {
    return {
      organizationId,
      userId,
      memberRole,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    };
  }
}

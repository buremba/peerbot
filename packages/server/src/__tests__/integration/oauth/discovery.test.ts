/**
 * OAuth Discovery Endpoint Tests
 *
 * Tests for RFC 9728 (Protected Resource Metadata) and RFC 8414 (Authorization Server Metadata).
 * These endpoints are used by MCP clients to discover OAuth configuration.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import { get } from '../../setup/test-helpers';

describe('OAuth Discovery Endpoints', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  describe('GET /.well-known/oauth-protected-resource', () => {
    it('should return valid protected resource metadata (RFC 9728)', async () => {
      const response = await get('/.well-known/oauth-protected-resource');
      const body = await response.json();

      expect(response.status).toBe(200);

      // Required fields per RFC 9728
      expect(body.resource).toBeDefined();
      expect(body.resource).toMatch(/\/mcp$/);

      expect(body.authorization_servers).toBeInstanceOf(Array);
      expect(body.authorization_servers.length).toBeGreaterThan(0);

      // Supported features
      expect(body.scopes_supported).toContain('mcp:read');
      expect(body.scopes_supported).toContain('mcp:write');
      expect(body.bearer_methods_supported).toContain('header');

      // Resource documentation
      expect(body.resource_name).toBeDefined();
    });

    it('should have consistent base URL in resource and authorization_servers', async () => {
      const response = await get('/.well-known/oauth-protected-resource');
      const body = await response.json();

      const resourceOrigin = new URL(body.resource).origin;
      const authServerOrigin = new URL(body.authorization_servers[0]).origin;

      expect(resourceOrigin).toBe(authServerOrigin);
    });
  });

  describe('GET /.well-known/oauth-authorization-server', () => {
    it('should return valid authorization server metadata (RFC 8414)', async () => {
      const response = await get('/.well-known/oauth-authorization-server');
      const body = await response.json();

      expect(response.status).toBe(200);

      // Required fields per RFC 8414
      expect(body.issuer).toBeDefined();
      expect(body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
      expect(body.token_endpoint).toMatch(/\/oauth\/token$/);

      // Optional but expected endpoints
      expect(body.registration_endpoint).toMatch(/\/oauth\/register$/);
      expect(body.revocation_endpoint).toMatch(/\/oauth\/revoke$/);

      // Supported features
      expect(body.response_types_supported).toContain('code');
      expect(body.grant_types_supported).toContain('authorization_code');
      expect(body.grant_types_supported).toContain('refresh_token');

      // OAuth 2.1 PKCE requirement
      expect(body.code_challenge_methods_supported).toContain('S256');

      // Token endpoint auth methods
      expect(body.token_endpoint_auth_methods_supported).toBeInstanceOf(Array);
      expect(body.token_endpoint_auth_methods_supported).toContain('client_secret_post');
    });

    it('should support OAuth 2.1 features', async () => {
      const response = await get('/.well-known/oauth-authorization-server');
      const body = await response.json();

      // OAuth 2.1 only supports 'code' response type (no implicit flow)
      expect(body.response_types_supported).toEqual(['code']);

      // Must support PKCE with S256
      expect(body.code_challenge_methods_supported).toContain('S256');
    });
  });

  describe('GET /.well-known/openid-configuration', () => {
    it('should return same metadata as oauth-authorization-server', async () => {
      const response1 = await get('/.well-known/oauth-authorization-server');
      const response2 = await get('/.well-known/openid-configuration');

      const body1 = await response1.json();
      const body2 = await response2.json();

      // Both endpoints should return the same metadata
      expect(body1).toEqual(body2);
    });
  });

  describe('MCP Client Discovery Flow', () => {
    it('should support the complete MCP discovery flow', async () => {
      // Step 1: Get protected resource metadata
      const protectedResource = await get('/.well-known/oauth-protected-resource');
      const prBody = await protectedResource.json();

      expect(protectedResource.status).toBe(200);

      // Step 2: Extract authorization server URL
      const authServerUrl = prBody.authorization_servers[0];
      expect(authServerUrl).toBeDefined();

      // Step 3: Get authorization server metadata
      const authServer = await get('/.well-known/oauth-authorization-server');
      const asBody = await authServer.json();

      expect(authServer.status).toBe(200);

      // Step 4: Verify all required endpoints are present
      expect(asBody.authorization_endpoint).toBeDefined();
      expect(asBody.token_endpoint).toBeDefined();
      expect(asBody.registration_endpoint).toBeDefined();

      // Step 5: Verify the issuer matches the authorization server
      const issuerOrigin = new URL(asBody.issuer).origin;
      const authServerOrigin = new URL(authServerUrl).origin;
      expect(issuerOrigin).toBe(authServerOrigin);
    });
  });
});

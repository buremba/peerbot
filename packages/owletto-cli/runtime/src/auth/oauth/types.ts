/**
 * OAuth 2.1 Type Definitions
 *
 * Based on MCP Authorization Specification (2025-06-18)
 * and RFC 7591 (Dynamic Client Registration)
 */

// ============================================
// Client Types (RFC 7591)
// ============================================

/**
 * OAuth client metadata for registration
 */
export interface OAuthClientMetadata {
  redirect_uris: string[];
  token_endpoint_auth_method?: 'none' | 'client_secret_post' | 'client_secret_basic';
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  software_id?: string;
  software_version?: string;
}

/**
 * Full OAuth client information (includes credentials)
 */
export interface OAuthClient extends OAuthClientMetadata {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number; // Unix timestamp
  client_secret_expires_at?: number; // Unix timestamp
}

/**
 * Stored client in database
 */
export interface StoredOAuthClient {
  id: string;
  client_secret: string | null;
  client_secret_expires_at: Date | null;
  client_id_issued_at: Date;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  scope: string | null;
  contacts: string[] | null;
  tos_uri: string | null;
  policy_uri: string | null;
  software_id: string | null;
  software_version: string | null;
  user_id: string | null;
  organization_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

// ============================================
// Token Types
// ============================================

/**
 * OAuth token response
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Stored token in database
 */
export interface StoredOAuthToken {
  id: string;
  token_type: 'access' | 'refresh';
  token_hash: string;
  client_id: string;
  user_id: string;
  organization_id: string | null;
  scope: string | null;
  resource: string | null;
  parent_token_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

// ============================================
// Authorization Code Types
// ============================================

/**
 * Stored authorization code in database
 */
export interface StoredAuthorizationCode {
  code: string;
  client_id: string;
  user_id: string;
  organization_id: string | null;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  scope: string | null;
  state: string | null;
  resource: string | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

// ============================================
// Authorization Request Types
// ============================================

/**
 * Authorization request parameters
 */
export interface AuthorizationParams {
  client_id: string;
  redirect_uri: string;
  response_type: 'code';
  scope?: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  resource?: string; // RFC 8707
}

/**
 * Token request parameters (authorization code grant, refresh, or device code)
 */
export interface TokenRequestParams {
  grant_type:
    | 'authorization_code'
    | 'refresh_token'
    | 'urn:ietf:params:oauth:grant-type:device_code';
  client_id: string;
  client_secret?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  refresh_token?: string;
  scope?: string;
  resource?: string;
  device_code?: string;
}

// ============================================
// Device Authorization Types (RFC 8628)
// ============================================

/**
 * Stored device code in database
 */
export interface StoredDeviceCode {
  device_code: string;
  user_code: string;
  client_id: string;
  scope: string | null;
  resource: string | null;
  user_id: string | null;
  organization_id: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  poll_interval: number;
  expires_at: Date;
  created_at: Date;
}

/**
 * Device authorization response (RFC 8628 Section 3.2)
 */
export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

// ============================================
// Auth Info (returned after token validation)
// ============================================

/**
 * Authentication info extracted from token
 */
export interface AuthInfo {
  userId: string;
  organizationId: string | null;
  clientId: string;
  scopes: string[];
  expiresAt: number; // Unix timestamp
  resource?: string;
  tokenType: 'access_token' | 'pat';
}

// ============================================
// Personal Access Token (PAT) Types
// ============================================

/**
 * Stored PAT in database
 */
export interface StoredPAT {
  id: number;
  key_hash: string;
  key_prefix: string;
  user_id: string;
  organization_id: string | null;
  name: string;
  description: string | null;
  scope: string | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * PAT creation response (includes plaintext token, shown once)
 */
export interface PATCreateResponse {
  id: number;
  token: string; // Plaintext, shown only once
  token_prefix: string;
  name: string;
  scope: string | null;
  expires_at: Date | null;
  created_at: Date;
}

/**
 * PAT list item (no plaintext token)
 */
export interface PATListItem {
  id: number;
  token_prefix: string;
  name: string;
  description: string | null;
  scope: string | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

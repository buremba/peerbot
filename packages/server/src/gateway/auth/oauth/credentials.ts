export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: number; // Unix timestamp in milliseconds
  scopes: string[];
}

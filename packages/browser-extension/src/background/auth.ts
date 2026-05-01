/**
 * Auth Manager
 * Handles OAuth flow with the Owletto platform using better-auth sessions
 *
 * Chrome extensions can't access cookies from launchWebAuthFlow popup,
 * so we use Bearer token authentication instead.
 */

import type { StateManager } from './state-manager';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5173';

export interface AuthResult {
  success: boolean;
  error?: string;
}

export interface UserInfo {
  id: string;
  email?: string;
  name?: string;
}

export class AuthManager {
  constructor(private state: StateManager) {}

  /**
   * Get stored session token
   */
  async getSessionToken(): Promise<string | undefined> {
    return this.state.get('sessionToken');
  }

  /**
   * Check if user is logged in by calling the session endpoint
   */
  async isLoggedIn(): Promise<boolean> {
    try {
      const token = await this.getSessionToken();
      if (!token) {
        console.log('[Owletto] No session token found');
        return false;
      }

      const response = await fetch(`${API_BASE_URL}/api/extension/auth/session`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        console.log('[Owletto] Session check returned:', response.status);
        return false;
      }

      const data = await response.json();
      if (data.authenticated && data.user) {
        // Cache user info
        await this.state.set('userId', data.user.id);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[Owletto] Session check error:', error);
      return false;
    }
  }

  /**
   * Get current user info
   */
  async getUserInfo(): Promise<UserInfo | null> {
    try {
      const token = await this.getSessionToken();
      if (!token) return null;

      const response = await fetch(`${API_BASE_URL}/api/extension/auth/session`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) return null;

      const data = await response.json();
      if (data.authenticated && data.user) {
        return data.user;
      }

      return null;
    } catch (error) {
      console.error('[Owletto] Get user info error:', error);
      return null;
    }
  }

  /**
   * Start OAuth login flow - opens login page in a new tab
   */
  async login(): Promise<AuthResult> {
    try {
      // Get the extension ID for the callback
      const extensionId = chrome.runtime.id;
      const callbackUrl = `chrome-extension://${extensionId}/callback.html`;

      // Build the auth URL
      const authUrl = `${API_BASE_URL}/api/extension/auth/login?redirect_uri=${encodeURIComponent(callbackUrl)}`;

      // Open login page in a new tab (same window)
      const tab = await chrome.tabs.create({ url: authUrl });

      // Wait for the callback
      return new Promise((resolve) => {
        const handleMessage = async (message: {
          type: string;
          success?: boolean;
          error?: string;
          userId?: string;
          sessionToken?: string;
        }) => {
          if (message.type === 'AUTH_CALLBACK') {
            chrome.runtime.onMessage.removeListener(handleMessage);

            // Close the auth tab
            if (tab.id) {
              try {
                await chrome.tabs.remove(tab.id);
              } catch {
                // Tab might already be closed
              }
            }

            if (message.error) {
              resolve({ success: false, error: message.error });
              return;
            }

            if (message.success && message.userId && message.sessionToken) {
              // Store session token for API calls
              await this.state.set('sessionToken', message.sessionToken);
              await this.state.set('userId', message.userId);

              await this.state.addActivityLog({
                type: 'auth',
                message: 'Successfully logged in',
              });

              console.log('[Owletto] Login successful');
              resolve({ success: true });
              return;
            }

            resolve({ success: false, error: 'Login failed - no session token received' });
          }
        };

        chrome.runtime.onMessage.addListener(handleMessage);

        // Timeout after 5 minutes
        setTimeout(
          () => {
            chrome.runtime.onMessage.removeListener(handleMessage);
            resolve({ success: false, error: 'Login timed out' });
          },
          5 * 60 * 1000
        );
      });
    } catch (error) {
      console.error('[Owletto] Login error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await this.state.addActivityLog({
        type: 'auth',
        message: `Login failed: ${errorMessage}`,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Logout - clear local state
   */
  async logout(): Promise<void> {
    await this.state.remove('sessionToken');
    await this.state.remove('userId');
    await this.state.remove('workerId');

    await this.state.addActivityLog({
      type: 'auth',
      message: 'Logged out',
    });

    console.log('[Owletto] Logged out');
  }

  /**
   * Get the current user ID
   */
  async getUserId(): Promise<string | undefined> {
    return this.state.get('userId');
  }
}

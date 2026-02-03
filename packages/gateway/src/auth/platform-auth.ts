/**
 * Platform-agnostic authentication adapter interface.
 * Each platform (Slack, WhatsApp) implements this to handle auth prompts in their native format.
 */

export interface AuthProvider {
  id: string;
  name: string;
}

export interface PlatformAuthAdapter {
  /**
   * Send authentication required prompt with provider list.
   * Platform implementations render this in their native format:
   * - Slack: Blocks with buttons
   * - WhatsApp: Numbered text list
   */
  sendAuthPrompt(
    userId: string,
    channelId: string,
    threadId: string,
    providers: AuthProvider[],
    platformMetadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Send authentication success message.
   */
  sendAuthSuccess(
    userId: string,
    channelId: string,
    provider: AuthProvider
  ): Promise<void>;

  /**
   * Handle potential auth response (e.g., numbered selection in WhatsApp).
   * Returns true if the message was handled as an auth response.
   */
  handleAuthResponse?(
    channelId: string,
    userId: string,
    text: string
  ): Promise<boolean>;
}

/**
 * Registry for platform auth adapters.
 * Used by orchestration layer to route auth prompts to correct platform.
 */
class PlatformAuthRegistry {
  private adapters = new Map<string, PlatformAuthAdapter>();

  register(platform: string, adapter: PlatformAuthAdapter): void {
    this.adapters.set(platform, adapter);
  }

  get(platform: string): PlatformAuthAdapter | undefined {
    return this.adapters.get(platform);
  }

  has(platform: string): boolean {
    return this.adapters.has(platform);
  }
}

// Global registry instance
export const platformAuthRegistry = new PlatformAuthRegistry();

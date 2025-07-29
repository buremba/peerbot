import { App, Installation, InstallationQuery } from "@slack/bolt";
import type { IncomingMessage, ServerResponse } from "http";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  scopes: string[];
  userScopes?: string[];
}

/**
 * Simple in-memory installation store
 * In production, this should be replaced with a persistent store (database, GCS, etc.)
 */
class SimpleInstallationStore {
  private installations: Map<string, Installation> = new Map();

  async storeInstallation(installation: Installation): Promise<void> {
    if (installation.isEnterpriseInstall && installation.enterprise) {
      // Enterprise installation
      const key = `enterprise-${installation.enterprise.id}`;
      this.installations.set(key, installation);
    } else if (installation.team) {
      // Single workspace installation
      const key = `team-${installation.team.id}`;
      this.installations.set(key, installation);
    }
    
    console.log("✅ Stored installation for:", installation.team?.name || installation.enterprise?.name);
  }

  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation> {
    let key: string;
    
    if (query.isEnterpriseInstall && query.enterpriseId) {
      key = `enterprise-${query.enterpriseId}`;
    } else if (query.teamId) {
      key = `team-${query.teamId}`;
    } else {
      throw new Error("No team or enterprise ID in query");
    }

    const installation = this.installations.get(key);
    if (!installation) {
      throw new Error(`No installation found for ${key}`);
    }

    return installation;
  }

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    let key: string;
    
    if (query.isEnterpriseInstall && query.enterpriseId) {
      key = `enterprise-${query.enterpriseId}`;
    } else if (query.teamId) {
      key = `team-${query.teamId}`;
    } else {
      throw new Error("No team or enterprise ID in query");
    }

    this.installations.delete(key);
    console.log("🗑️ Deleted installation for:", key);
  }
}

export class OAuthHandler {
  private installationStore = new SimpleInstallationStore();
  
  constructor(private config: OAuthConfig) {}

  /**
   * Configure OAuth for the Slack app
   */
  configureOAuth(app: App): void {
    // OAuth configuration is handled in the App constructor
    // This method is for any additional OAuth-related setup
    
    console.log("🔐 OAuth configured with scopes:", this.config.scopes.join(", "));
    
    // Add success/failure handlers
    this.setupOAuthHandlers(app);
  }

  /**
   * Get OAuth configuration for Bolt App
   */
  getOAuthConfig() {
    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      stateSecret: this.config.stateSecret,
      scopes: this.config.scopes,
      userScopes: this.config.userScopes,
      installationStore: this.installationStore,
      installerOptions: {
        directInstall: true,
        installPath: '/slack/install',
        redirectUriPath: '/slack/oauth_redirect',
        callbackOptions: {
          success: async (installation: Installation, _options: any, _req: IncomingMessage, res: ServerResponse) => {
            // Custom success handling
            console.log("✅ Installation successful for team:", installation.team?.name);
            
            // Store tokens in environment or database
            if (installation.bot?.token) {
              console.log("Bot token obtained:", installation.bot.token.substring(0, 20) + "...");
              
              // You can store this in your database or update Kubernetes secrets here
              // For now, we'll just log it
              console.log("\n📝 Update your .env with:");
              console.log(`SLACK_BOT_TOKEN=${installation.bot.token}`);
              console.log(`SLACK_TEAM_ID=${installation.team?.id}`);
              console.log(`SLACK_BOT_USER_ID=${installation.bot.userId}`);
            }
            
            // Redirect to success page
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <head>
                  <title>Installation Successful</title>
                  <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
                    .container { max-width: 600px; margin: 100px auto; text-align: center; }
                    .success { color: #22c55e; font-size: 48px; }
                    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <div class="success">✅</div>
                    <h1>Installation Successful!</h1>
                    <p>PeerCloud bot has been installed to your workspace.</p>
                    <p>You can now use <code>@peercloud</code> in your Slack channels.</p>
                    <br>
                    <a href="slack://open">Open Slack</a>
                  </div>
                </body>
              </html>
            `);
          },
          failure: async (error: Error, _options: any, _req: IncomingMessage, res: ServerResponse) => {
            // Custom failure handling
            console.error("❌ Installation failed:", error);
            
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <head>
                  <title>Installation Failed</title>
                  <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
                    .container { max-width: 600px; margin: 100px auto; text-align: center; }
                    .error { color: #ef4444; font-size: 48px; }
                    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <div class="error">❌</div>
                    <h1>Installation Failed</h1>
                    <p>There was an error installing the PeerCloud bot.</p>
                    <p>Error: ${error.message}</p>
                    <br>
                    <a href="/slack/install">Try Again</a>
                  </div>
                </body>
              </html>
            `);
          }
        }
      }
    };
  }

  /**
   * Setup additional OAuth handlers
   */
  private setupOAuthHandlers(_app: App): void {
    // You can add additional OAuth-related routes here if needed
    console.log("✅ OAuth handlers configured");
  }

  /**
   * Get the installation store
   */
  getInstallationStore() {
    return this.installationStore;
  }
}
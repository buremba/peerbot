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
declare class SimpleInstallationStore {
    private installations;
    storeInstallation(installation: Installation): Promise<void>;
    fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation>;
    deleteInstallation(query: InstallationQuery<boolean>): Promise<void>;
}
export declare class OAuthHandler {
    private config;
    private installationStore;
    constructor(config: OAuthConfig);
    /**
     * Configure OAuth for the Slack app
     */
    configureOAuth(app: App): void;
    /**
     * Get OAuth configuration for Bolt App
     */
    getOAuthConfig(): {
        clientId: string;
        clientSecret: string;
        stateSecret: string;
        scopes: string[];
        userScopes: string[] | undefined;
        installationStore: SimpleInstallationStore;
        installerOptions: {
            directInstall: boolean;
            installPath: string;
            redirectUriPath: string;
            callbackOptions: {
                success: (installation: Installation, _options: any, _req: IncomingMessage, res: ServerResponse) => Promise<void>;
                failure: (error: Error, _options: any, _req: IncomingMessage, res: ServerResponse) => Promise<void>;
            };
        };
    };
    /**
     * Setup additional OAuth handlers
     */
    private setupOAuthHandlers;
    /**
     * Get the installation store
     */
    getInstallationStore(): SimpleInstallationStore;
}
export {};
//# sourceMappingURL=oauth-handler.d.ts.map
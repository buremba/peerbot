export declare class SlackTokenManager {
    private clientId;
    private clientSecret;
    private refreshToken;
    private currentToken;
    private tokenExpiresAt;
    private refreshTimer?;
    constructor(clientId: string, clientSecret: string, refreshToken: string, initialToken: string);
    refreshAccessToken(): Promise<string>;
    private scheduleTokenRefresh;
    getCurrentToken(): string;
    getValidToken(): Promise<string>;
    stop(): void;
}
//# sourceMappingURL=token-manager.d.ts.map
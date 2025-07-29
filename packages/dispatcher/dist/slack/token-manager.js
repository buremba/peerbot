// src/slack/token-manager.ts
class SlackTokenManager {
  clientId;
  clientSecret;
  refreshToken;
  currentToken;
  tokenExpiresAt;
  refreshTimer;
  constructor(clientId, clientSecret, refreshToken, initialToken) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.currentToken = initialToken;
    this.tokenExpiresAt = Date.now() + 11 * 60 * 60 * 1000;
    this.scheduleTokenRefresh();
  }
  async refreshAccessToken() {
    console.log("Refreshing Slack access token...");
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
      refresh_token: this.refreshToken
    });
    try {
      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      });
      const data = await response.json();
      if (data.ok) {
        this.currentToken = data.access_token;
        if (data.refresh_token) {
          this.refreshToken = data.refresh_token;
        }
        const expiresIn = data.expires_in || 12 * 60 * 60;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;
        console.log(`✅ Token refreshed successfully. Expires in ${expiresIn} seconds`);
        this.scheduleTokenRefresh();
        return this.currentToken;
      } else {
        throw new Error(`Failed to refresh token: ${data.error}`);
      }
    } catch (error) {
      console.error("Error refreshing token:", error);
      throw error;
    }
  }
  scheduleTokenRefresh() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    const refreshIn = this.tokenExpiresAt - Date.now() - 30 * 60 * 1000;
    if (refreshIn > 0) {
      console.log(`Scheduling token refresh in ${Math.round(refreshIn / 1000 / 60)} minutes`);
      this.refreshTimer = setTimeout(() => {
        this.refreshAccessToken().catch((error) => {
          console.error("Failed to refresh token:", error);
          setTimeout(() => this.refreshAccessToken(), 5 * 60 * 1000);
        });
      }, refreshIn);
    } else {
      this.refreshAccessToken().catch((error) => {
        console.error("Failed to refresh token:", error);
      });
    }
  }
  getCurrentToken() {
    return this.currentToken;
  }
  async getValidToken() {
    if (Date.now() > this.tokenExpiresAt - 30 * 60 * 1000) {
      await this.refreshAccessToken();
    }
    return this.currentToken;
  }
  stop() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }
}
export {
  SlackTokenManager
};

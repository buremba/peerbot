/**
 * ChatGPT device-auth helper. Resolves wire config from the loaded OAuth
 * registry (providers.json). Only construct when actually starting a device
 * flow — the ChatGPT runtime module no longer needs this at boot.
 */

import { OAuthClient } from "../oauth/client.js";
import { getOAuthProviderConfig } from "../oauth/providers.js";

export class ChatGPTDeviceCodeClient extends OAuthClient {
  constructor() {
    const config = getOAuthProviderConfig("chatgpt");
    if (!config) {
      throw new Error(
        'ChatGPT OAuth config not loaded — ensure providers.json has a "chatgpt" entry with an oauth block',
      );
    }
    super(config);
  }
}

/**
 * ChatGPT device-auth helper for the ChatGPT provider module.
 * Resolves wire config from the loaded OAuth registry (providers.json) — no
 * hard-coded endpoints.
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

/**
 * Shared claim extraction for the two worker-token mints — the per-run
 * `runJobToken` (message-consumer) and the deployment-lifetime `WORKER_TOKEN`
 * (deployment-manager). Both read the SAME routing claims off the message;
 * the #1274 P0 was an omitted-claim divergence between exactly these two mints
 * (the per-run mint dropped `connectionId`, so every chat `ask_user` 500'd at
 * `assertRoutableInteraction`).
 *
 * Keeping the common bag here makes that parity invariant structural: any
 * routing claim a downstream consumer reads off the verified token
 * (channelId, teamId, platform, agentId, organizationId, connectionId,
 * responseThreadId, source) is set in ONE place for both mints. Mint-specific
 * claims (runId+messageId for the per-run token, traceId for the deployment
 * token) stay with each caller.
 */
export interface WorkerTokenClaimsArgs {
	channelId: string;
	teamId?: string;
	agentId?: string;
	organizationId?: string;
	platform?: string;
	platformMetadata?: Record<string, unknown>;
	/**
	 * Selected runtime provider for this conversation, resolved from the agent's
	 * sandbox by the caller (which has the agent settings + sandbox store).
	 * Undefined → local just-bash. The generic runtime route reads this claim to
	 * pick a provider — see WorkerTokenData.runtimeProviderId.
	 */
	runtimeProviderId?: string;
	/** The `sandboxes.id` whose vault credential backs the provider above. */
	sandboxId?: string;
	/**
	 * The agent's resolved egress allowlist (`networkConfig.allowedDomains`). Set
	 * here so the runtime route can read it off the SIGNED token instead of
	 * trusting a worker-supplied body — see WorkerTokenData.allowedDomains.
	 */
	allowedDomains?: string[];
	/**
	 * The agent's resolved egress denylist (`networkConfig.deniedDomains`),
	 * signed for the same reason — see WorkerTokenData.deniedDomains.
	 */
	deniedDomains?: string[];
	/**
	 * The agent's resolved nix package set (`nixConfig.packages`, already unioned
	 * with connector-contributed tooling). Signed for the same reason as the
	 * domain lists: every entry reaches a package-install command line inside the
	 * sandbox, so the worker must not be able to name it — see
	 * WorkerTokenData.nixPackages.
	 */
	nixPackages?: string[];
}

/**
 * The routing claims common to both worker-token mints, in the exact shape the
 * `generateWorkerToken` options object expects. `connectionId`,
 * `responseThreadId`, and `source` are lifted off `platformMetadata`
 * (string-guarded — all default to `undefined` when absent or non-string).
 *
 * `connectionId`: PRIMARY/fallback auth must carry it or interaction posts
 * (ask_user / tool approval / link button) hit `assertRoutableInteraction`,
 * which rejects a chat-platform interaction with no connectionId (#1274).
 *
 * `responseThreadId`: full Chat SDK thread id selected by the gateway. Worker
 * response bodies are untrusted, so outbound routing may consume only this
 * signed copy.
 *
 * `source`: headless run origin — interaction cards from this turn are stamped
 * headless and skip the SSE-owner gate (no browser SSE exists on any pod for a
 * headless run, so an owner-gated card would dead-letter).
 */
export function buildWorkerTokenClaims(args: WorkerTokenClaimsArgs): {
	channelId: string;
	teamId?: string;
	agentId?: string;
	organizationId?: string;
	platform?: string;
	connectionId?: string;
	responseThreadId?: string;
	source?: string;
	runtimeProviderId?: string;
	sandboxId?: string;
	allowedDomains?: string[];
	deniedDomains?: string[];
	nixPackages?: string[];
} {
	// Provider comes solely from the conversation's pinned sandbox; there is
	// no deployment-wide env-var fallback. Undefined → local just-bash.
	const runtimeProviderId = args.runtimeProviderId;
	return {
		channelId: args.channelId,
		teamId: args.teamId,
		agentId: args.agentId,
		organizationId: args.organizationId,
		platform: args.platform,
		connectionId:
			typeof args.platformMetadata?.connectionId === "string"
				? args.platformMetadata.connectionId
				: undefined,
		responseThreadId:
			typeof args.platformMetadata?.responseThreadId === "string"
				? args.platformMetadata.responseThreadId
				: undefined,
		source:
			typeof args.platformMetadata?.source === "string"
				? args.platformMetadata.source
				: undefined,
		runtimeProviderId,
		sandboxId: runtimeProviderId ? args.sandboxId : undefined,
		// Non-empty only; an empty list is equivalent to absent (deny-all) and
		// keeps the token payload minimal.
		allowedDomains:
			args.allowedDomains && args.allowedDomains.length > 0
				? args.allowedDomains
				: undefined,
		deniedDomains:
			args.deniedDomains && args.deniedDomains.length > 0
				? args.deniedDomains
				: undefined,
		// Same non-empty-only shape rule as the domain lists. Not gated on
		// `runtimeProviderId`: a conversation's pin is resolved per turn and can
		// change between the mint and the exec, and only the runtime route reads
		// this claim anyway — the local just-bash path wraps the worker spawn in
		// nix-shell and ignores it.
		nixPackages:
			args.nixPackages && args.nixPackages.length > 0
				? args.nixPackages
				: undefined,
	};
}

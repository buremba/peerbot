import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { magicLink, organization, phoneNumber } from "better-auth/plugins";
import type { Env } from "../index";
import { getAuthDialect, getDb } from "../db/client";
import { sendTransactionalEmail } from "../email/send";
import {
	InvitationEmail,
	invitationSubject,
} from "../email/templates/invitation";
import {
	MagicLinkEmail,
	magicLinkSubject,
} from "../email/templates/magic-link";
import {
	PasswordResetEmail,
	passwordResetSubject,
} from "../email/templates/password-reset";
import { notifyInvitationReceived } from "../notifications/triggers";
import {
	deleteMemberEntity,
	ensureMemberEntity,
	updateMemberEntityAccess,
	updateMemberEntityStatus,
} from "../utils/member-entity";
import {
	getConfiguredPublicOrigin,
	normalizeHost,
} from "../utils/public-origin";
import { TtlCache } from "../utils/ttl-cache";
import { resolveBaseUrl, safeParseUrl } from "./base-url";
import {
	getAuthConfig as getAuthConfigFromEnv,
	getEnabledLoginProviderConfigs,
	resolveDefaultOrganizationId,
	resolveLoginProviderCredentials,
	resolveRequestOrganizationId,
} from "./config";
import { connectorCapabilityRegistry } from "../identity/capability-registry";
// Side-effect import: each connector self-registers on load, so the
// registry is fully populated before any auth hook can fire.
import "../identity/connectors";
import {
	scheduleIdentityIngest,
	scheduleIdentityTombstoneOnAccountDelete,
} from "../identity/auth-hook";

function gravatarUrl(email: string): string {
	const hash = createHash("md5")
		.update(email.trim().toLowerCase())
		.digest("hex");
	return `https://www.gravatar.com/avatar/${hash}?d=retro&s=256`;
}

// Cache betterAuth instances per organizationId to avoid re-creating on every request.
// The config (OAuth providers) rarely changes, so 60s TTL is safe.
const authCache = new TtlCache<ReturnType<typeof betterAuth>>(60_000);

/**
 * Create a better-auth instance with all plugins configured.
 *
 * OAuth providers are dynamically loaded from connector_definitions where login_enabled=true.
 * This allows enabling/disabling login providers via the admin UI without code changes.
 */
export async function createAuth(env: Env, request?: Request) {
	const organizationId = (await resolveRequestOrganizationId(request)) ?? null;
	const cacheKey = organizationId ?? "__system__";
	const cached = authCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	const authConfig = await getAuthConfigFromEnv(env, {
		organizationId,
		request,
	});
	const runtimeNodeEnv = env.NODE_ENV || process.env.NODE_ENV || "development";

	const effectiveOrgId =
		organizationId ?? (await resolveDefaultOrganizationId());
	const providerRows = await getEnabledLoginProviderConfigs(effectiveOrgId);

	// Build dynamic social providers from enabled connectors
	const socialProviders: Record<
		string,
		{ clientId: string; clientSecret: string; scope?: string[] }
	> = {};

	for (const row of providerRows) {
		const provider = row.provider;
		const credentials = await resolveLoginProviderCredentials({
			env,
			provider,
			connectorKey: row.connectorKey,
			clientIdKey: row.clientIdKey,
			clientSecretKey: row.clientSecretKey,
			organizationId: effectiveOrgId,
		});
		const clientId = credentials.clientId ?? "";
		const clientSecret = credentials.clientSecret ?? "";

		if (!clientId || !clientSecret) continue;
		if (socialProviders[provider]) continue;

		// Pass the connector-declared login scopes directly to Better Auth.
		// Each connector owns its OAuth configuration; core does not inject defaults.
		socialProviders[provider] = {
			clientId,
			clientSecret,
			...(row.loginScopes.length > 0 && { scope: row.loginScopes }),
		};
	}

	// Warn for any enabled social provider that has no identity-engine
	// connector. Sign-in still works; facts simply aren't ingested. Connectors
	// are loaded statically at the top of the file, so the registry is
	// guaranteed populated by the time we reach this check.
	for (const provider of Object.keys(socialProviders)) {
		if (!connectorCapabilityRegistry.emitter(provider.trim().toLowerCase())) {
			console.warn(
				`[Auth] Social provider "${provider}" is enabled but has no identity connector — facts will not be ingested for sign-ins via this provider.`,
			);
		}
	}

	const trustedOriginSet = new Set<string>([
		"http://localhost:4821",
		"http://localhost:3000",
		"http://localhost:5173",
		"http://127.0.0.1:4821",
		"http://127.0.0.1:3000",
		"http://127.0.0.1:5173",
	]);

	// In development, trust localhost on the configured port
	if (runtimeNodeEnv === "development") {
		const port = process.env.PORT || "8787";
		trustedOriginSet.add(`http://localhost:${port}`);
		trustedOriginSet.add(`http://127.0.0.1:${port}`);
	}
	const addTrustedOriginVariants = (rawUrl?: string) => {
		const parsed = safeParseUrl(rawUrl);
		if (!parsed) return;
		trustedOriginSet.add(parsed.origin);

		// Support frontends served on the default port for the same hostname
		// when BASE_URL includes explicit ports (e.g. :8787/:4822).
		if (parsed.port) {
			trustedOriginSet.add(`${parsed.protocol}//${parsed.hostname}`);
		}
	};
	addTrustedOriginVariants(getConfiguredPublicOrigin());
	// Also trust the baseURL (resolves from PUBLIC_WEB_URL, forwarded headers, or request URL)
	addTrustedOriginVariants(resolveBaseUrl({ request }));

	// When AUTH_COOKIE_DOMAIN is set (e.g. ".lobu.ai"), trust all subdomains so
	// session cookies travel across {org}.lobu.ai → lobu.ai cross-origin requests.
	// Normalize via normalizeHost so IDN/uppercase/trailing-dot variants of the
	// env value cannot silently mismatch the ASCII-lowercased origin BetterAuth
	// sees from the browser.
	const normalizedCookieZone = normalizeHost(process.env.AUTH_COOKIE_DOMAIN);
	if (normalizedCookieZone) {
		trustedOriginSet.add(`https://*.${normalizedCookieZone}`);
		trustedOriginSet.add(`https://${normalizedCookieZone}`);
	}

	const auth = betterAuth({
		...(env.BETTER_AUTH_SECRET ? { secret: env.BETTER_AUTH_SECRET } : {}),
		database: { dialect: getAuthDialect(), type: "postgres" },
		baseURL: resolveBaseUrl({ request }),
		basePath: "/api/auth",

		emailAndPassword: {
			enabled: authConfig.emailPassword,
			requireEmailVerification: false,
			sendResetPassword: async ({ user, url }) => {
				await sendTransactionalEmail({
					env,
					to: user.email,
					category: "auth",
					subject: passwordResetSubject,
					react: <PasswordResetEmail url={url} />,
				});
			},
		},

		// OAuth providers - dynamically loaded from connector_definitions
		// Tokens are reusable for both login AND connectors
		socialProviders,

		account: {
			accountLinking: {
				enabled: true,
				// Trust only the social providers that are actually configured for this org.
				// Keep core auth connector-agnostic: provider trust should be data-driven from
				// enabled login providers, not hardcoded per connector/provider in app code.
				trustedProviders: Object.keys(socialProviders),
				updateUserInfoOnLink: true,
			},
		},

		// Session configuration
		session: {
			expiresIn: 60 * 60 * 24 * 7, // 7 days
			updateAge: 60 * 60 * 24, // Update session daily
		},

		// Plugins
		plugins: [
			// Organization plugin with teams support
			organization({
				allowUserToCreateOrganization: true,
				creatorRole: "owner",
				organizationHooks: {
					afterAddMember: async ({ member, user, organization: org }) => {
						try {
							await ensureMemberEntity({
								organizationId: org.id,
								userId: user.id,
								name: user.name || user.email,
								email: user.email,
								image: user.image ?? undefined,
								role: member.role,
							});
							const { invalidateMembershipRoleCache } = await import(
								"../workspace/multi-tenant"
							);
							invalidateMembershipRoleCache(org.id, user.id);
						} catch (err) {
							console.error(
								"[Auth] Failed to create $member entity after addMember:",
								err,
							);
						}
					},
					afterAcceptInvitation: async ({
						member,
						user,
						organization: org,
					}) => {
						try {
							// Update existing invited entity to active, or create if missing
							await updateMemberEntityStatus(org.id, user.email, "active");
							await ensureMemberEntity({
								organizationId: org.id,
								userId: user.id,
								name: user.name || user.email,
								email: user.email,
								image: user.image ?? undefined,
								role: member.role,
								status: "active",
							});
							const { invalidateMembershipRoleCache } = await import(
								"../workspace/multi-tenant"
							);
							invalidateMembershipRoleCache(org.id, user.id);
						} catch (err) {
							console.error(
								"[Auth] Failed to update $member entity after acceptInvitation:",
								err,
							);
						}
					},
					afterRemoveMember: async ({ user, organization: org }) => {
						try {
							await deleteMemberEntity(org.id, user.email);
							const { invalidateMembershipRoleCache } = await import(
								"../workspace/multi-tenant"
							);
							invalidateMembershipRoleCache(org.id, user.id);
						} catch (err) {
							console.error(
								"[Auth] Failed to clean up $member entity after removeMember:",
								err,
							);
						}
					},
					afterUpdateMemberRole: async ({
						member,
						user,
						organization: org,
					}) => {
						try {
							await updateMemberEntityAccess(org.id, user.email, {
								role: member.role,
								status: "active",
							});
							const { invalidateMembershipRoleCache } = await import(
								"../workspace/multi-tenant"
							);
							invalidateMembershipRoleCache(org.id, user.id);
						} catch (err) {
							console.error(
								"[Auth] Failed to update $member entity after updateMemberRole:",
								err,
							);
						}
					},
					afterCreateInvitation: async ({
						invitation,
						inviter,
						organization: org,
					}) => {
						try {
							await ensureMemberEntity({
								organizationId: org.id,
								userId: inviter.id,
								name: invitation.email,
								email: invitation.email,
								role: invitation.role,
								status: "invited",
							});
						} catch (err) {
							console.error(
								"[Auth] Failed to create $member entity after createInvitation:",
								err,
							);
						}
					},
					afterCancelInvitation: async ({ invitation, organization: org }) => {
						try {
							await deleteMemberEntity(org.id, invitation.email);
						} catch (err) {
							console.error(
								"[Auth] Failed to delete $member entity after cancelInvitation:",
								err,
							);
						}
					},
					afterRejectInvitation: async ({ invitation, organization: org }) => {
						try {
							await deleteMemberEntity(org.id, invitation.email);
						} catch (err) {
							console.error(
								"[Auth] Failed to delete $member entity after rejectInvitation:",
								err,
							);
						}
					},
				},
				sendInvitationEmail: async (data, request) => {
					const orgId = data.organization.id;
					const orgName = data.organization.name;
					const email = data.email;
					const inviterName = data.inviter?.user?.name ?? undefined;

					try {
						const baseUrl = resolveBaseUrl({ request });
						const acceptUrl = `${baseUrl}/auth/accept-invitation?invitationId=${data.id}`;
						await sendTransactionalEmail({
							env,
							to: email,
							category: "invite",
							subject: invitationSubject({ inviterName, orgName }),
							react: (
								<InvitationEmail
									inviterName={inviterName}
									orgName={orgName}
									acceptUrl={acceptUrl}
								/>
							),
						});
					} catch (err) {
						console.error("[Auth] Failed to send invitation email:", err);
					}

					// Also send in-app notification if user already exists
					try {
						const sql = getDb();
						const userRows = await sql<{ id: string }>`
              SELECT id FROM "user" WHERE email = ${email} LIMIT 1
            `;
						const userId = userRows[0]?.id;
						if (userId) {
							await notifyInvitationReceived({
								orgId,
								userId,
								orgName,
								inviterName,
							});
						}
					} catch (err) {
						console.error(
							"[Auth] Failed to send invitation notification:",
							err,
						);
					}
				},
			}),

			// Magic link authentication
			magicLink({
				sendMagicLink: async ({ email, url }) => {
					if (!env.RESEND_API_KEY && runtimeNodeEnv !== "production") {
						console.info(
							{ email, url },
							"[Auth] Development magic link generated (RESEND_API_KEY not configured)",
						);
						throw new Error(
							"Magic-link email delivery is not configured (RESEND_API_KEY missing). Check server logs for the generated link.",
						);
					}
					await sendTransactionalEmail({
						env,
						to: email,
						category: "auth",
						subject: magicLinkSubject,
						react: <MagicLinkEmail url={url} />,
					});
				},
				expiresIn: 60 * 15, // 15 minutes
			}),

			// Phone number authentication via WhatsApp
			phoneNumber({
				sendOTP: async ({ phoneNumber: phone, code }) => {
					if (!env.TWILIO_SID || !env.TWILIO_TOKEN) {
						console.warn("[Auth] Twilio not configured, skipping WhatsApp OTP");
						return;
					}
					// Use Twilio REST API directly to avoid dependency
					const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`;
					const auth = Buffer.from(
						`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`,
					).toString("base64");

					const response = await fetch(twilioUrl, {
						method: "POST",
						headers: {
							Authorization: `Basic ${auth}`,
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: new URLSearchParams({
							From: `whatsapp:${env.TWILIO_WHATSAPP_NUMBER}`,
							To: `whatsapp:${phone}`,
							Body: `Your Lobu verification code: ${code}`,
						}),
					});

					if (!response.ok) {
						const error = await response.text();
						console.error("[Auth] Twilio error:", error);
						throw new Error("Failed to send verification code");
					}
				},
				otpLength: 6,
				expiresIn: 60 * 5, // 5 minutes
			}),
		],

		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						if (!user.image && user.email) {
							return { data: { ...user, image: gravatarUrl(user.email) } };
						}
						return { data: user };
					},
					after: async (user) => {
						try {
							const { ensurePersonalOrganization } = await import(
								"./personal-org-provisioning"
							);
							const result = await ensurePersonalOrganization({
								id: user.id,
								email: user.email,
								name: user.name,
								username:
									(user as { username?: string | null }).username ?? null,
							});
							if (result.created) {
								console.log(
									`[Auth] Provisioned personal org ${result.slug} for user ${user.id}`,
								);
							}
						} catch (error) {
							console.error("[Auth] Failed to provision personal org:", error);
						}
					},
				},
			},
			account: {
				create: {
					after: async (account, context) => {
						const accountSummary = {
							id: account.id,
							userId: account.userId,
							providerId: account.providerId,
							accessToken: (account as Record<string, unknown>).accessToken as
								| string
								| null,
							scope: (account as Record<string, unknown>).scope as
								| string
								| null,
						};
						try {
							const { provisionConnectorFromSocialLogin } = await import(
								"./social-login-provisioning"
							);
							await provisionConnectorFromSocialLogin({
								env,
								request: context?.request ?? undefined,
								account: accountSummary,
							});
						} catch (error) {
							console.error(
								"[Auth] Failed to auto-provision connector from social login:",
								error,
							);
						}
						// Identity engine ingest. Fire-and-forget; sign-in never blocks.
						scheduleIdentityIngest(accountSummary);
					},
				},
				update: {
					after: async (account, context) => {
						const accountSummary = {
							id: account.id,
							userId: account.userId,
							providerId: account.providerId,
							accessToken: (account as Record<string, unknown>).accessToken as
								| string
								| null,
							scope: (account as Record<string, unknown>).scope as
								| string
								| null,
						};
						try {
							const { provisionConnectorFromSocialLogin } = await import(
								"./social-login-provisioning"
							);
							await provisionConnectorFromSocialLogin({
								env,
								request: context?.request ?? undefined,
								account: accountSummary,
							});
						} catch (error) {
							console.error(
								"[Auth] Failed to refresh connector provisioning from social login:",
								error,
							);
						}
						scheduleIdentityIngest(accountSummary);
					},
				},
				delete: {
					after: async (account) => {
						// Unlinking an OAuth account must tombstone every fact we ever
						// ingested under it so derivations get revoked. Without this hook
						// disconnected providers keep producing reads forever.
						scheduleIdentityTombstoneOnAccountDelete({
							id: account.id,
							userId: account.userId,
							providerId: account.providerId,
						});
					},
				},
			},
		},

		advanced: {
			useSecureCookies:
				runtimeNodeEnv === "production" ||
				safeParseUrl(getConfiguredPublicOrigin())?.protocol === "https:",
			...(process.env.AUTH_COOKIE_DOMAIN
				? {
						crossSubDomainCookies: {
							enabled: true,
							domain: process.env.AUTH_COOKIE_DOMAIN,
						},
					}
				: {}),
		},

		trustedOrigins: Array.from(trustedOriginSet),
	});
	// betterAuth's inferred return narrows generics per call site (socialProviders
	// shape, required-vs-optional database/secret); the cache stores the general
	// Auth<BetterAuthOptions> shape, so widen via unknown.
	authCache.set(cacheKey, auth as unknown as ReturnType<typeof betterAuth>);
	return auth;
}

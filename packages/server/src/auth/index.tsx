import { createHash } from "node:crypto";
import { passkey } from "@better-auth/passkey";
import { APIError, betterAuth } from "better-auth";
import { magicLink, organization, phoneNumber } from "better-auth/plugins";
import { bearer } from "better-auth/plugins/bearer";
import { getAuthDialect, getDb } from "../db/client";
import { sendTransactionalEmail } from "../email/send";
import {
	InvitationEmail,
	invitationSubject,
} from "../email/templates/invitation";
import {
	authorizeAppSubject,
	MagicLinkEmail,
	magicLinkSubject,
} from "../email/templates/magic-link";
import {
	PasswordResetEmail,
	passwordResetSubject,
} from "../email/templates/password-reset";
import { WelcomeEmail, welcomeSubject } from "../email/templates/welcome";
import { connectorCapabilityRegistry } from "../identity/capability-registry";
import type { Env } from "../index";
import { notifyInvitationReceived } from "../notifications/triggers";
import { recordLifecycleEvent } from "../utils/insert-event";
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
import { findExistingPersonalOrg } from "./personal-org-provisioning";
// Side-effect imports: each connector self-registers on load, so the
// registry is fully populated before any auth hook can fire. Add a new
// import here when adding a connector under `../identity/connectors/`.
import "../identity/connectors/google";

if (connectorCapabilityRegistry.size() === 0) {
	throw new Error(
		"identity connector registry is empty — check side-effect imports in auth/index.tsx",
	);
}

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
 * Drop every cached betterAuth instance. Production never needs this (env is
 * stable per-process), but integration tests that flip env vars like
 * LOBU_SINGLE_USER between cases must bust the cache, or a stale instance
 * built under the previous env serves the request and the hook closures
 * read the wrong flag.
 */
export function clearAuthCacheForTests(): void {
	authCache.clear();
}

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
		database: {
			dialect: getAuthDialect(),
			type: "postgres",
			transaction: true,
		},
		baseURL: resolveBaseUrl({ request }),
		basePath: "/api/auth",

		emailAndPassword: {
			enabled: authConfig.emailPassword,
			requireEmailVerification: false,
			sendResetPassword: async ({ user, url }) => {
				// Carve-out: the synthetic install_operator user (auto-provisioned
				// at boot) authenticates with ENCRYPTION_KEY and uses a synthetic
				// install@<hostname> email that doesn't deliver. Refuse password
				// reset for it so an accidental "forgot password" can't replace
				// the operator's credential. See docs/install-operator-bootstrap.md.
				const sql = getDb();
				const rows = (await sql`
					SELECT principal_kind FROM "user"
					 WHERE id = ${user.id} LIMIT 1
				`) as unknown as Array<{ principal_kind: string }>;
				if (rows[0]?.principal_kind === "install_operator") {
					throw new APIError("FORBIDDEN", {
						code: "PASSWORD_RESET_NOT_ALLOWED_FOR_INSTALL_OPERATOR",
						message:
							"Password reset is not available for the install operator. Use the install's ENCRYPTION_KEY to sign in.",
					});
				}
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

		user: {
			additionalFields: {
				// Declared so the where-clause in the single-user guard
				// below resolves through BA's adapter. DB column has
				// `NOT NULL DEFAULT 'human'` (db/migrations/...principal_kind.sql),
				// so `input: false` lets the default fill in on signup.
				principalKind: {
					type: "string",
					fieldName: "principal_kind",
					input: false,
					returned: false,
					required: false,
				},
				// Surface `username` in the session payload. The SPA derives a
				// user's home org from session.user.username (personalOrgSlug) to
				// route them straight to /$owner — without this it's absent from
				// the session, so routing falls back to the (slow) /api/organizations
				// fetch on every cold load. `input: false`: it's set server-side by
				// the personal-org provisioner, never by client signup input.
				username: {
					type: "string",
					fieldName: "username",
					input: false,
					returned: true,
					required: false,
				},
			},
		},

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
			// Accept the Better Auth session token as Authorization: Bearer too.
			// Used by the macOS menu bar and the CLI's `local` context — both hold
			// a session token minted via POST /api/local-init and prefer
			// bearer headers to managing a cookie jar. Cookie auth still works
			// for browser SPAs unchanged.
			bearer(),
			// Organization plugin with teams support
			organization({
				allowUserToCreateOrganization: true,
				creatorRole: "owner",
				organizationHooks: {
					// If a user manually creates a private org while they have no
					// personal-org marker yet, tag it as their personal one. Without
					// this, `personal_org_for_user_id` only gets set by the
					// auto-provisioner in `databaseHooks.user.create.after` — anyone
					// whose auto-provisioned org was deleted, or who manually created
					// their first org via the UI, ends up with NULL `workerOrgIds`
					// in the device-worker auth middleware (index.ts:602-607), so
					// their Lobu bridge gets a 403 on every poll.
					afterCreateOrganization: async ({ organization: org, user }) => {
						try {
							if (org.visibility !== "private") return;
							const sql = getDb();
							const existing = await findExistingPersonalOrg(user.id, sql);
							if (existing) return;
							await sql`
								UPDATE "organization"
								SET metadata = jsonb_set(
									COALESCE(metadata::jsonb, '{}'::jsonb),
									'{personal_org_for_user_id}',
									to_jsonb(${user.id}::text)
								)::text
								WHERE id = ${org.id}
							`;
						} catch (err) {
							console.error(
								"[Auth] Failed to mark created org as personal:",
								err,
							);
						}
					},
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
							recordLifecycleEvent({
								organizationId: org.id,
								entityType: "member",
								op: "created",
								entityId: member.id,
								summary: `Member "${user.name || user.email}" added`,
								extra: { user_id: user.id, role: member.role },
							});
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
							recordLifecycleEvent({
								organizationId: org.id,
								entityType: "member",
								op: "deleted",
								entityId: user.id,
								summary: `Member "${user.name || user.email}" removed`,
							});
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
					// Carve-out: refuse magic-link for the synthetic install_operator
					// row. Its synthetic install@<hostname> email is non-deliverable
					// and admitting a magic-link would let any caller who can guess
					// the hostname mint an operator session via the email channel,
					// bypassing the ENCRYPTION_KEY guard. See
					// docs/install-operator-bootstrap.md.
					const sql = getDb();
					const rows = (await sql`
						SELECT principal_kind FROM "user"
						 WHERE email = ${email} LIMIT 1
					`) as unknown as Array<{ principal_kind: string }>;
					if (rows[0]?.principal_kind === "install_operator") {
						throw new APIError("FORBIDDEN", {
							code: "MAGIC_LINK_NOT_ALLOWED_FOR_INSTALL_OPERATOR",
							message:
								"Magic link is not available for the install operator. Use the install's ENCRYPTION_KEY to sign in.",
						});
					}

					if (!env.RESEND_API_KEY && runtimeNodeEnv !== "production") {
						console.info(
							{ email, url },
							"[Auth] Development magic link generated (RESEND_API_KEY not configured)",
						);
						throw new Error(
							"Magic-link email delivery is not configured (RESEND_API_KEY missing). Check server logs for the generated link.",
						);
					}
					// A magic link whose callbackURL targets the device consent page
					// is an agent/app authorization request (POST /oauth/device/email),
					// not a routine login — frame the email accordingly so the user
					// doesn't grant third-party access thinking they're just signing in.
					let isAuthorizeRequest = false;
					try {
						const callbackUrl =
							new URL(url).searchParams.get("callbackURL") ?? "";
						isAuthorizeRequest =
							decodeURIComponent(callbackUrl).includes("/oauth/device");
					} catch {
						isAuthorizeRequest = false;
					}
					await sendTransactionalEmail({
						env,
						to: email,
						category: "auth",
						subject: isAuthorizeRequest
							? authorizeAppSubject
							: magicLinkSubject,
						react: (
							<MagicLinkEmail
								url={url}
								mode={isAuthorizeRequest ? "authorize" : "sign-in"}
							/>
						),
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
			// WebAuthn / passkey support. Especially useful in local-mode
			// (LOBU_SINGLE_USER=1) where Touch ID / Face ID is a much cleaner
			// auth than "remember the password you typed at /sign-up." Default
			// `requireSession: true` for registration means the operator
			// signs up with email+password first, then enrolls a passkey from
			// settings (or a post-signup prompt). Sign-in then offers
			// "Sign in with passkey" as a one-tap biometric option.
			//
			// rpID = the hostname WebAuthn binds the credential to. Pulled
			// from PUBLIC_WEB_URL (env), NOT from resolveBaseUrl(request) —
			// resolveBaseUrl reflects the request that happened to construct
			// this BA instance, and createAuth() is cached for 60s, so a
			// request from one host could freeze the rpID for the next host's
			// request. PUBLIC_WEB_URL is stable per-deployment.
			//
			// origin defaults to the request Origin header — handled by the
			// plugin itself when we pass `null`. That keeps WebAuthn-side
			// origin verification accurate for Vite dev (SPA on a different
			// port than the API) and prod.
			passkey({
				rpID: (() => {
					const publicWebUrl = process.env.PUBLIC_WEB_URL?.trim();
					if (publicWebUrl) {
						try {
							const host = new URL(publicWebUrl).hostname;
							if (host) return host;
						} catch {
							/* fallthrough to default */
						}
					}
					return "localhost";
				})(),
				rpName: "Lobu",
				origin: null,
			}),
		],

		databaseHooks: {
			user: {
				create: {
					before: async (user, ctx) => {
						// Single-user-mode chokepoint. The URL filter in index.ts
						// blocks /api/auth/sign-up/*, but Better Auth also creates
						// users on magic-link verify and OAuth callbacks; this hook
						// fires before every user INSERT.
						if (env.LOBU_SINGLE_USER === "1") {
							// Exclude the synthetic install_operator row
							// (auto-provisioned by ensureInstallOperator) so the
							// first human signup still proceeds. See
							// docs/install-operator-bootstrap.md.
							const existing =
								await ctx!.context.internalAdapter.countTotalUsers([
									{
										field: "principalKind",
										operator: "ne",
										value: "install_operator",
									},
								]);
							if (existing > 0) {
								throw new APIError("FORBIDDEN", {
									code: "SIGN_UP_DISABLED_IN_SINGLE_USER_MODE",
									message:
										"This install allows exactly one user; sign in to the existing account instead.",
								});
							}
						}
						if (!user.image && user.email) {
							return { data: { ...user, image: gravatarUrl(user.email) } };
						}
						return { data: user };
					},
					after: async (user, context) => {
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
								// Default agent used to be seeded at `lobu run` boot when the
								// bootstrap org existed up front. Without that seed, the first
								// real signup is the first moment we have an org to provision
								// against; do it here so the user lands with an agent ready
								// instead of having to restart `lobu run`. Best-effort —
								// failure does not block signup, and start-local.ts also runs
								// ensureDefaultAgent on next boot as a backstop.
								try {
									const { ensureDefaultAgent } = await import(
										"./default-provisioning"
									);
									await ensureDefaultAgent(result.organizationId);
								} catch (agentError) {
									console.error(
										"[Auth] Default-agent provisioning at signup failed:",
										agentError,
									);
								}
							}
						} catch (error) {
							console.error("[Auth] Failed to provision personal org:", error);
						}

						if (!env.RESEND_API_KEY && runtimeNodeEnv !== "production") {
							console.info(
								{ email: user.email },
								"[Auth] Development signup welcome email skipped (RESEND_API_KEY not configured)",
							);
							return;
						}
						// Fire-and-forget: the welcome email hits an external API
						// (Resend). Better Auth awaits user.create.after before
						// completing signup, so awaiting the send blocks the signup
						// response on an external HTTP call. On a busy single node that
						// blocked request contends with the SPA's immediate
						// /api/organizations fetch — observed pushing it to multi-second
						// latency right after signup. The email is non-critical; send it
						// in the background. (appUrl is resolved synchronously here, before
						// the request context is torn down.)
						void sendTransactionalEmail({
							env,
							to: user.email,
							category: "auth",
							subject: welcomeSubject,
							react: (
								<WelcomeEmail
									name={user.name}
									appUrl={resolveBaseUrl({
										request: context?.request ?? undefined,
									})}
								/>
							),
						}).catch((error) => {
							console.error(
								"[Auth] Failed to send signup welcome email:",
								error,
							);
						});
					},
				},
			},
			account: {
				create: {
					before: async (account, ctx) => {
						// Carve-out: refuse OAuth account-linking onto the synthetic
						// install_operator user. The operator authenticates via
						// ENCRYPTION_KEY; admitting social-login linking would pin a
						// real human identity onto the operator row, which is exactly
						// the fork between "the install" and "a person" the
						// principal_kind discriminator exists to prevent. Allow the
						// `credential` provider so ensureInstallOperator can write the
						// password-hash row at boot. See
						// docs/install-operator-bootstrap.md.
						if (account.providerId !== "credential") {
							const linkedUser =
								await ctx!.context.internalAdapter.findUserById(account.userId);
							const principalKind = (
								linkedUser as { principalKind?: string } | null
							)?.principalKind;
							if (principalKind === "install_operator") {
								throw new APIError("FORBIDDEN", {
									code: "ACCOUNT_LINKING_NOT_ALLOWED_FOR_INSTALL_OPERATOR",
									message:
										"Cannot link a social account to the install operator. Sign up as a real user first.",
								});
							}
						}
						return { data: account };
					},
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

-- migrate:up

-- Correct the stale `auth_profiles` table comment. The original (applied in the
-- baseline migration) described it as "Per-user-per-agent", but the table has
-- no agent_id/user_id columns: it is org-scoped (`organization_id` NOT NULL)
-- and reusable. Per-(user, agent) linkage is a separate join table
-- (`user_auth_profiles`). Comment-only change — no data/schema alteration.

COMMENT ON TABLE public.auth_profiles IS 'Org-scoped reusable auth state for connector- and provider-mediated identities (API keys via profile_kind=env, OAuth tokens, browser sessions). Referenced by connections.auth_profile_id / app_auth_profile_id and by the user_auth_profiles (user_id, agent_id) join table. device_workers binding applies only to browser_session profiles minted via /api/me/devices/mint-child-token.';

-- migrate:down

COMMENT ON TABLE public.auth_profiles IS 'Per-user-per-agent OAuth / auth state for connector-mediated user identities. Holds tokens, refresh tokens, expiry, and the pending-auth workflow state. Bound to a device_workers.worker_id when minted via /api/me/devices/mint-child-token.';

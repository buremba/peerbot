-- migrate:up

-- The old `auth_profiles_pending_unique` partial index keyed pending-row
-- uniqueness on (organization_id, connector_key, profile_kind, provider) with
-- no caller dimension. For `oauth_account` (which is user-personal per the
-- comment in handleCreateAuthProfile and the per-user authData semantics),
-- that blocked two users in the same org from running parallel OAuth flows
-- for the same connector — User B's INSERT collided with User A's in-flight
-- pending row. The semantically correct constraint for oauth_account is
-- per-(user, connector, provider).
--
-- Other profile_kinds today are written with status='active' from creation
-- (oauth_app, env via upsertConnectorAuthProfiles; browser_session via
-- worker-api), so the old "one pending per kind/provider" bound was unused
-- in practice for them. Drop the constraint there rather than reproduce it
-- under a different shape; createAuthProfile still raises a typed error if
-- a future pending INSERT ever collides on the new index.
DROP INDEX IF EXISTS public.auth_profiles_pending_unique;

CREATE UNIQUE INDEX auth_profiles_pending_oauth_account_unique
  ON public.auth_profiles
  USING btree (organization_id, connector_key, provider, created_by)
  WHERE (status = 'pending_auth'::text AND profile_kind = 'oauth_account'::text);

COMMENT ON INDEX public.auth_profiles_pending_oauth_account_unique IS
  'At most one in-flight oauth_account pending-auth profile per (org, connector, provider, user). Lets distinct members start parallel OAuth flows for the same connector; blocks the same user from duplicating their own flow.';

-- migrate:down

DROP INDEX IF EXISTS public.auth_profiles_pending_oauth_account_unique;

CREATE UNIQUE INDEX auth_profiles_pending_unique
  ON public.auth_profiles
  USING btree (organization_id, connector_key, profile_kind, provider)
  WHERE (status = 'pending_auth'::text);

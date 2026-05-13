-- migrate:up

-- Maps a chat-platform user (Slack `U…`, …) to a Lobu account. Recorded as a
-- side effect of `/lobu link <code>` — the code is minted by an authenticated
-- `lobu run`, so `oauth_states.payload.createdBy` is the Lobu user. Once a user
-- is linked here, they can re-bind any chat to an agent they can manage via
-- `/lobu link <agentId>` without minting a fresh code.

CREATE TABLE IF NOT EXISTS public.chat_user_identities (
    platform          text NOT NULL,
    team_id           text NOT NULL DEFAULT '',  -- workspace id; '' for platforms without one
    platform_user_id  text NOT NULL,
    lobu_user_id      text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, team_id, platform_user_id)
);

CREATE INDEX IF NOT EXISTS chat_user_identities_lobu_user_idx
    ON public.chat_user_identities (lobu_user_id);

-- migrate:down

DROP TABLE IF EXISTS public.chat_user_identities;

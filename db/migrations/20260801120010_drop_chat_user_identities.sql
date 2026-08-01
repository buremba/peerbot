-- migrate:up

-- Drop `chat_user_identities`. Its job moved to the entity graph.
--
-- The table mapped `(platform, team_id, platform_user_id) → lobu_user_id`
-- globally. Every reader now resolves the same fact from
-- `entity_identities(namespace = 'slack_user_id')`, whose identifier is the
-- composite workspace-scoped `TEAM:USER` key — so the workspace scoping that
-- made this table correct is carried in the key itself, not in a column.
--
-- Why this is not a downgrade:
--   * The stamp is written by `persistLoginSlackIdentity` on every Slack OAuth
--     sign-in AND token refresh, resolving the team from the id_token claim
--     with a userinfo fallback, and refusing to write a bare unscoped id.
--   * The install-claim path re-stamps idempotently, including the Grid
--     ENTERPRISE key (`E…`) that OAuth alone cannot prove.
--   * Readers fail closed: a principal resolving to more than one DISTINCT auth
--     user returns null rather than picking one.
--
-- The one writer that is NOT replaced is the preview-code redemption removed
-- earlier in this sequence: it recorded an ASSUMED identity (that the redeemer
-- is the code's minter) into a table that authorizes Slack approval clicks.
-- Dropping it is the point, not a casualty.
--
-- No data migration. Every row this table held is derivable from, and already
-- present in, the graph for any user who has signed in with Slack; a user who
-- has not re-stamps on their next sign-in. There are no external consumers —
-- `git grep chat_user_identities origin/main` is confined to this table's own
-- readers, all of which are repointed in this change.

-- squawk-ignore ban-drop-table -- the point of this migration; every reader is repointed at entity_identities in this change
DROP TABLE IF EXISTS chat_user_identities;

-- migrate:down

-- Recreates the (empty) structure only. The mappings themselves are not
-- recoverable from here — they live in entity_identities now, and re-deriving
-- them would mean re-deciding the workspace scoping this table encoded in
-- columns and the graph encodes in the key.

CREATE TABLE IF NOT EXISTS chat_user_identities (
    platform text NOT NULL,
    team_id text DEFAULT ''::text NOT NULL,
    platform_user_id text NOT NULL,
    lobu_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (platform, team_id, platform_user_id)
);

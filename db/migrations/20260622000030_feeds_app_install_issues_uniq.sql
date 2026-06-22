-- migrate:up transaction:false

-- DB-enforced idempotency for GitHub App auto-provisioned issue feeds.
--
-- The install callback's auto-provision step (autoProvisionGithubIssueFeeds)
-- creates one `issues` feed per accessible repo on the install's connection.
-- Two concurrent install completions for the same org+install (distinct nonces:
-- a double-click or a second tab) run AFTER linkGithubAppInstallation's advisory
-- lock has released, so a SELECT-then-INSERT in app code can have both callers
-- SELECT-miss and both INSERT — duplicate issue feeds for the same repo. App
-- code cannot serialize this without a backing constraint; enforce it here.
--
-- Identity is (connection, repo) for issue feeds: at most ONE active issues feed
-- per (connection_id, repo_owner, repo_name). Scoped to feed_key='issues' and
-- deleted_at IS NULL so it only governs live auto-provisioned issue feeds and
-- never collides with other feed kinds, soft-deleted rows, or feeds whose config
-- omits a repo (the index expression yields NULL → not indexed). The INSERT uses
-- ON CONFLICT on these columns to converge concurrent callers to one row.
--
-- CONCURRENTLY (transaction:false, one statement) so the build never locks the
-- feeds table at prod row counts — matches the require-concurrent-index-creation
-- lint, so no squawk-ignore is needed.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS feeds_app_install_issues_uniq
    ON public.feeds (
        connection_id,
        ((config ->> 'repo_owner')),
        ((config ->> 'repo_name'))
    )
    WHERE feed_key = 'issues' AND deleted_at IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.feeds_app_install_issues_uniq;

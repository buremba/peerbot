-- Pre-merge audit for docs/plans/mcp-query-run-split.md. Non-zero counts mean
-- those users must re-authenticate (OAuth) or reissue their PAT after merge.
-- Refresh tokens are included: a valid null-org refresh token mints null-org
-- access tokens, so it would re-trigger the rejection on the next exchange.
-- Usage: psql "$DATABASE_URL" -f scripts/audit-null-org-tokens.sql

\echo '=== Active null-org tokens ==='
SELECT
  (SELECT COUNT(*) FROM oauth_tokens
   WHERE organization_id IS NULL AND token_type = 'access'
     AND revoked_at IS NULL AND expires_at > NOW()) AS oauth_access_null_org,
  (SELECT COUNT(*) FROM oauth_tokens
   WHERE organization_id IS NULL AND token_type = 'refresh'
     AND revoked_at IS NULL AND expires_at > NOW()) AS oauth_refresh_null_org,
  (SELECT COUNT(*) FROM personal_access_tokens
   WHERE organization_id IS NULL AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > NOW())) AS pat_active_null_org;

\echo '=== Affected user IDs ==='
SELECT DISTINCT user_id, source FROM (
  SELECT user_id, 'oauth_access'  AS source FROM oauth_tokens
    WHERE organization_id IS NULL AND token_type = 'access'
      AND revoked_at IS NULL AND expires_at > NOW()
  UNION ALL
  SELECT user_id, 'oauth_refresh' AS source FROM oauth_tokens
    WHERE organization_id IS NULL AND token_type = 'refresh'
      AND revoked_at IS NULL AND expires_at > NOW()
  UNION ALL
  SELECT user_id, 'pat'           AS source FROM personal_access_tokens
    WHERE organization_id IS NULL AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
) t ORDER BY user_id, source;

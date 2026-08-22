-- migrate:up

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS next_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS completed_window_coverage tstzmultirange NOT NULL DEFAULT '{}'::tstzmultirange,
  ADD COLUMN IF NOT EXISTS window_projection_granularity text;

COMMENT ON COLUMN automations.next_window_start IS
  'Oldest logical Automation period not yet completed; advanced only by fenced window completion.';
COMMENT ON COLUMN automations.completed_window_coverage IS
  'Compact completed scheduled periods at or after next_window_start; event runs are excluded.';
COMMENT ON COLUMN automations.window_projection_granularity IS
  'Granularity used to interpret next_window_start and completed_window_coverage.';

-- History is scanned exactly once here. Request paths read the compact Automation-row
-- projection and never reconstruct scheduled coverage from runs.
WITH automation_granularity AS (
  SELECT
    a.id,
    CASE
      WHEN a.schedule IS NULL THEN 'weekly'
      WHEN cardinality(regexp_split_to_array(trim(a.schedule), E'\\s+')) < 5 THEN 'weekly'
      WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[4] <> '*'
        AND (regexp_split_to_array(trim(a.schedule), E'\\s+'))[3] <> '*' THEN 'quarterly'
      WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[3] <> '*'
        AND (regexp_split_to_array(trim(a.schedule), E'\\s+'))[4] = '*' THEN 'monthly'
      WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[5] <> '*'
        AND (regexp_split_to_array(trim(a.schedule), E'\\s+'))[3] = '*' THEN 'weekly'
      WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[2] <> '*'
        AND (regexp_split_to_array(trim(a.schedule), E'\\s+'))[3] = '*' THEN 'daily'
      WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[2] = '*'
        OR (regexp_split_to_array(trim(a.schedule), E'\\s+'))[2] LIKE '%/%'
        OR (regexp_split_to_array(trim(a.schedule), E'\\s+'))[2] LIKE '%,%' THEN 'daily'
      ELSE 'weekly'
    END AS granularity
  FROM automations a
  WHERE a.next_window_start IS NULL
     OR a.window_projection_granularity IS NULL
), boundaries AS (
  SELECT
    id,
    granularity,
    CASE granularity
      WHEN 'daily' THEN date_trunc('day', current_timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      WHEN 'weekly' THEN date_trunc('week', current_timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      WHEN 'monthly' THEN date_trunc('month', current_timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ELSE date_trunc('quarter', current_timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    END AS closed_boundary
  FROM automation_granularity
), normalized_runs AS (
  SELECT
    r.automation_id,
    r.status,
    r.action_output,
    b.granularity,
    CASE b.granularity
      WHEN 'daily' THEN date_trunc('day', (r.approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      WHEN 'weekly' THEN date_trunc('week', (r.approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      WHEN 'monthly' THEN date_trunc('month', (r.approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ELSE date_trunc('quarter', (r.approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    END AS period_start
  FROM runs r
  JOIN boundaries b ON b.id = r.automation_id
  WHERE r.run_type = 'automation'
    AND COALESCE(r.approved_input->>'dispatch_source', 'scheduled') <> 'event'
    AND r.approved_input->>'window_start' IS NOT NULL
), periodized_runs AS (
  SELECT
    automation_id,
    status,
    action_output,
    granularity,
    period_start,
    CASE granularity
      WHEN 'daily' THEN period_start + interval '1 day'
      WHEN 'weekly' THEN period_start + interval '1 week'
      WHEN 'monthly' THEN period_start + interval '1 month'
      ELSE period_start + interval '3 months'
    END AS period_end
  FROM normalized_runs
), completed_periods AS (
  SELECT DISTINCT automation_id, granularity, period_start, period_end
  FROM periodized_runs
  WHERE status = 'completed'
    AND action_output IS NOT NULL
), fallback_cursor AS (
  SELECT
    b.id,
    b.granularity,
    b.closed_boundary,
    CASE
      WHEN max(c.period_start) IS NULL THEN
        CASE b.granularity
          WHEN 'daily' THEN b.closed_boundary - interval '1 day'
          WHEN 'weekly' THEN b.closed_boundary - interval '1 week'
          WHEN 'monthly' THEN b.closed_boundary - interval '1 month'
          ELSE b.closed_boundary - interval '3 months'
        END
      ELSE LEAST(max(c.period_end), b.closed_boundary)
    END AS fallback_start
  FROM boundaries b
  LEFT JOIN completed_periods c ON c.automation_id = b.id
  GROUP BY b.id, b.granularity, b.closed_boundary
), cursor_candidates AS (
  SELECT
    f.id,
    f.granularity,
    LEAST(
      f.fallback_start,
      COALESCE((
        SELECT min(p.period_start)
        FROM periodized_runs p
        WHERE p.automation_id = f.id
          AND p.status IN ('pending', 'claimed', 'running', 'failed', 'timeout', 'cancelled')
          AND NOT EXISTS (
            SELECT 1
            FROM completed_periods completed
            WHERE completed.automation_id = p.automation_id
              AND completed.period_start = p.period_start
          )
      ), f.fallback_start),
      COALESCE((
        SELECT min(completed.period_end)
        FROM completed_periods completed
        WHERE completed.automation_id = f.id
          AND NOT EXISTS (
            SELECT 1
            FROM completed_periods successor
            WHERE successor.automation_id = completed.automation_id
              AND successor.period_start = completed.period_end
          )
      ), f.fallback_start)
    ) AS next_window_start
  FROM fallback_cursor f
), projection AS (
  SELECT
    candidate.id,
    candidate.granularity,
    candidate.next_window_start,
    COALESCE(
      range_agg(tstzrange(completed.period_start, completed.period_end, '[)'))
        FILTER (WHERE completed.period_start >= candidate.next_window_start),
      '{}'::tstzmultirange
    ) AS completed_window_coverage
  FROM cursor_candidates candidate
  LEFT JOIN completed_periods completed ON completed.automation_id = candidate.id
  GROUP BY candidate.id, candidate.granularity, candidate.next_window_start
)
UPDATE automations automation
SET next_window_start = projection.next_window_start,
    completed_window_coverage = projection.completed_window_coverage,
    window_projection_granularity = projection.granularity
FROM projection
WHERE automation.id = projection.id
  AND (
    automation.next_window_start IS NULL
    OR automation.window_projection_granularity IS NULL
  );

-- migrate:down

ALTER TABLE automations
  DROP COLUMN IF EXISTS window_projection_granularity,
  DROP COLUMN IF EXISTS completed_window_coverage,
  DROP COLUMN IF EXISTS next_window_start;

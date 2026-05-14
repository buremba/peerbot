-- migrate:up

-- Collapse `connection.config.auto_approve_actions` (string[]) and
-- `connection.config.require_approval_actions` (string[]) into a single
-- `action_modes` (Record<string, 'disabled' | 'approval' | 'auto'>) map.
--
-- The old two-array model couldn't express "agent must not call this op
-- at all" — every action the connector defined was always reachable, the
-- arrays only flipped approval prompts. The new map adds 'disabled' as the
-- third state and gives every op an explicit user-chosen mode.
--
-- Backfill rule, per row, for every op listed in either array:
--   op in auto_approve_actions      → action_modes[op] = 'auto'
--   op in require_approval_actions  → action_modes[op] = 'approval'
-- When an op appears in both, 'approval' wins (it's the stricter signal:
-- the user explicitly opted in to seeing an approval prompt).
--
-- Ops the user never touched are not stored in action_modes; the server
-- falls back to the connector's per-op `requires_approval` default at read
-- time, which preserves today's "all on" behavior.
--
-- We drop the two old keys in the same statement so the new state is the
-- only state on disk after migration.

UPDATE public.connections
SET config = (
        COALESCE(config, '{}'::jsonb)
        - 'auto_approve_actions'
        - 'require_approval_actions'
    )
    || jsonb_build_object(
        'action_modes',
        COALESCE(
            (
                -- 'approval' wins over 'auto' when an op appears in both arrays
                -- (MIN('approval', 'auto') = 'approval' lexicographically).
                SELECT jsonb_object_agg(op_key, mode)
                FROM (
                    SELECT op_key, MIN(mode) AS mode
                    FROM (
                        SELECT op_key, 'approval'::text AS mode
                        FROM jsonb_array_elements_text(
                            CASE
                                WHEN jsonb_typeof(config->'require_approval_actions') = 'array'
                                    THEN config->'require_approval_actions'
                                ELSE '[]'::jsonb
                            END
                        ) AS op_key
                        UNION ALL
                        SELECT op_key, 'auto'::text AS mode
                        FROM jsonb_array_elements_text(
                            CASE
                                WHEN jsonb_typeof(config->'auto_approve_actions') = 'array'
                                    THEN config->'auto_approve_actions'
                                ELSE '[]'::jsonb
                            END
                        ) AS op_key
                    ) all_modes
                    GROUP BY op_key
                ) collapsed
            ),
            '{}'::jsonb
        )
    )
WHERE config IS NOT NULL
  AND (
      config ? 'auto_approve_actions'
      OR config ? 'require_approval_actions'
  );

-- migrate:down

-- Reverse the collapse: split action_modes back into the two arrays.
-- 'auto'     → auto_approve_actions
-- 'approval' → require_approval_actions
-- 'disabled' has no pre-refactor equivalent and is silently dropped on
-- downgrade — the agent will see the op again as if no override existed.
UPDATE public.connections
SET config = (
        COALESCE(config, '{}'::jsonb) - 'action_modes'
    )
    || jsonb_build_object(
        'auto_approve_actions',
        COALESCE(
            (
                SELECT jsonb_agg(key)
                FROM jsonb_each_text(config->'action_modes')
                WHERE value = 'auto'
            ),
            '[]'::jsonb
        ),
        'require_approval_actions',
        COALESCE(
            (
                SELECT jsonb_agg(key)
                FROM jsonb_each_text(config->'action_modes')
                WHERE value = 'approval'
            ),
            '[]'::jsonb
        )
    )
WHERE config IS NOT NULL
  AND jsonb_typeof(config->'action_modes') = 'object';

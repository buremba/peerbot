-- migrate:up

ALTER TABLE public.watchers
  ADD COLUMN IF NOT EXISTS delivery_target jsonb;

COMMENT ON COLUMN public.watchers.delivery_target IS
  'Strict bound chat destination for Behavior notifications: {connection_id, channel_id}. NULL keeps legacy org-wide delivery.';

-- ADD CONSTRAINT has no IF NOT EXISTS. Guard it so a manually recovered
-- partial application can be replayed and still converge.
DO $add_delivery_target_shape$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.watchers'::regclass
      AND conname = 'watchers_delivery_target_shape'
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE public.watchers
        ADD CONSTRAINT watchers_delivery_target_shape
        CHECK (
          delivery_target IS NULL
          OR (
            jsonb_typeof(delivery_target) = 'object'
            AND jsonb_typeof(delivery_target->'connection_id') = 'number'
            AND delivery_target->>'connection_id' ~ '^[1-9][0-9]*$'
            AND jsonb_typeof(delivery_target->'channel_id') = 'string'
            AND length(delivery_target->>'channel_id') > 0
            AND delivery_target - 'connection_id' - 'channel_id' = '{}'::jsonb
          )
        ) NOT VALID
    $ddl$;
  END IF;
END
$add_delivery_target_shape$;

-- The column add is metadata-only. Validation scans the bounded watchers config
-- table without rewriting it; the surrounding dbmate transaction retains the
-- brief ADD lock until this scan completes.
DO $validate_delivery_target_shape$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.watchers'::regclass
      AND conname = 'watchers_delivery_target_shape'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.watchers
      VALIDATE CONSTRAINT watchers_delivery_target_shape;
  END IF;
END
$validate_delivery_target_shape$;

-- migrate:down

ALTER TABLE public.watchers
  DROP CONSTRAINT IF EXISTS watchers_delivery_target_shape;

ALTER TABLE public.watchers
  DROP COLUMN IF EXISTS delivery_target;

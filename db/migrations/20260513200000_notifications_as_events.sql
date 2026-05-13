-- migrate:up

-- Unify notifications with events.
--
-- A notification was a (org, user, title, body, type, resource_url) row in
-- its own table with per-user `is_read`. Conceptually it's an event with a
-- particular kind + per-user delivery / read-state. This migration turns
-- every notification into:
--   1. an event with semantic_type='notification' (org-wide visibility in
--      the events stream — searchable, addressable, links into knowledge);
--   2. a notification_targets row (event_id, user_id, delivered_at, read_at)
--      so the inbox still scopes to the targeted user.
--
-- After this, "send to admins" inserts one event + N targets; "mark read"
-- updates a target row; "unread count" counts target rows without read_at.
-- Search across events naturally includes notifications, but a user's
-- inbox is still private to them.

CREATE TABLE public.notification_targets (
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    delivered_at timestamp with time zone NOT NULL DEFAULT now(),
    read_at timestamp with time zone,
    PRIMARY KEY (event_id, user_id)
);

-- Fast inbox lookups: list a user's unread notifications, newest first.
CREATE INDEX idx_notification_targets_user_unread
    ON public.notification_targets (user_id, delivered_at DESC)
    WHERE read_at IS NULL;

-- All of a user's notifications, newest first (for read-list pagination).
CREATE INDEX idx_notification_targets_user_all
    ON public.notification_targets (user_id, delivered_at DESC);

-- Backfill existing notifications. We keep 1:1 row mapping (one event per
-- legacy notification) for safety — at scale the right model is "one event,
-- many targets" but the old schema didn't capture that and we can't
-- retroactively coalesce without an oracle.
WITH legacy AS (
    SELECT id, organization_id, user_id, type, title, body,
           resource_type, resource_id, resource_url, is_read, created_at
    FROM public.notifications
    ORDER BY id ASC
),
inserted AS (
    INSERT INTO public.events
        (organization_id, title, payload_text, payload_type, semantic_type,
         occurred_at, created_at, metadata, origin_id)
    SELECT
        l.organization_id,
        l.title,
        l.body,
        'text',
        'notification',
        l.created_at,
        l.created_at,
        jsonb_build_object(
            'notification_type', l.type,
            'resource_type', l.resource_type,
            'resource_id', l.resource_id,
            'resource_url', l.resource_url,
            'legacy_notification_id', l.id
        ),
        'notification:legacy:' || l.id::text
    FROM legacy l
    RETURNING id AS event_id, (metadata->>'legacy_notification_id')::bigint AS legacy_id
)
INSERT INTO public.notification_targets (event_id, user_id, delivered_at, read_at)
SELECT
    i.event_id,
    l.user_id,
    l.created_at,
    CASE WHEN l.is_read THEN l.created_at ELSE NULL END
FROM inserted i
JOIN public.notifications l ON l.id = i.legacy_id;

-- Drop the legacy table. All readers/writers go through the new service.
DROP TABLE public.notifications;

-- migrate:down

-- One-way migration. Recovery is from backup; events created here stay
-- (deleting them would also wipe their notification_targets via CASCADE).
-- If you really need to roll back: re-create the table, copy notifications
-- back out of events + notification_targets, drop the event rows.

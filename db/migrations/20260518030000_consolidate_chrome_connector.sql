-- migrate:up

BEGIN;

-- Consolidate four standalone Owletto-for-Chrome connectors
-- (`chrome.tabs`, `browser.evaluate`, `browser.page_text`, `browser.fill_form`)
-- into one `chrome` connector that declares them as feeds of itself.
--
-- Rationale: each paired Chrome profile is conceptually one integration
-- exposing multiple capabilities (tabs feed + JS evaluate + page text +
-- form fill), not four separate "connectors" all bound to the same device
-- worker. The pre-consolidation shape forced the admin UI to render four
-- rows under one chrome-extension device, which misrepresented the
-- integration. See packages/connectors/src/chrome.ts for the unified
-- definition and apps/chrome/background.js for the matching dispatch.
--
-- Migration shape: collapse, don't rename. Per (organization_id,
-- device_worker_id) tuple, one of the existing rows is chosen as
-- canonical (preferring the chrome.tabs row when present because it
-- already owns the auto-wired open_tabs feed); its connector_key is
-- promoted to 'chrome'. All feeds + pending runs on the non-canonical
-- rows are repointed to the canonical connection, with feed_keys 'page'
-- → 'page_text' and 'fill' → 'fill_form' renamed to match the new
-- definition. The non-canonical rows are soft-deleted so they no longer
-- collide on the live-rows uniqueness index
-- (idx_connections_org_connector_device_live).

-- 1. Archive the old connector_definitions rows. Connector-catalog
-- queries `status = 'active'`, so flipping to 'archived' is enough to
-- stop the gateway from auto-wiring them on the next reconcile pass.
UPDATE public.connector_definitions
SET status = 'archived',
    updated_at = now()
WHERE key IN (
    'chrome.tabs',
    'browser.evaluate',
    'browser.page_text',
    'browser.fill_form'
)
AND status = 'active';

-- 2. Choose one canonical connection per (org, device_worker_id) tuple,
-- preferring chrome.tabs (already has the open_tabs feed wired) and
-- breaking ties by lowest id. Includes unpinned rows
-- (device_worker_id IS NULL) treated as a separate tuple so they get
-- consolidated too; otherwise they'd survive with archived definitions
-- and feeds would keep materializing old-key runs the worker rejects.
CREATE TEMPORARY TABLE chrome_canonical AS
SELECT DISTINCT ON (organization_id, device_worker_id)
    id,
    organization_id,
    device_worker_id
FROM public.connections
WHERE connector_key IN (
        'chrome.tabs',
        'browser.evaluate',
        'browser.page_text',
        'browser.fill_form'
    )
  AND deleted_at IS NULL
ORDER BY organization_id, device_worker_id,
         (connector_key = 'chrome.tabs') DESC,
         id ASC;

-- 3. Repoint feeds on non-canonical old connections to the canonical
-- one, renaming feed_key for the action wrappers ('page' → 'page_text',
-- 'fill' → 'fill_form'). Feeds on the canonical connection get the
-- rename treatment in step 4.
-- Match canonical by organization_id and device_worker_id-as-text so
-- tuples with NULL device_worker_id collapse the same way as pinned
-- ones.
UPDATE public.feeds f
SET connection_id = canon.id,
    feed_key = CASE
        WHEN f.feed_key = 'page' THEN 'page_text'
        WHEN f.feed_key = 'fill' THEN 'fill_form'
        ELSE f.feed_key
    END,
    updated_at = now()
FROM public.connections oldc
JOIN chrome_canonical canon
  ON canon.organization_id = oldc.organization_id
 AND canon.device_worker_id IS NOT DISTINCT FROM oldc.device_worker_id
WHERE f.connection_id = oldc.id
  AND oldc.id <> canon.id
  AND oldc.connector_key IN (
        'chrome.tabs',
        'browser.evaluate',
        'browser.page_text',
        'browser.fill_form'
    )
  AND f.deleted_at IS NULL;

-- 4. Rename feed_key on feeds that already live on the canonical
-- connection (the canonical might happen to be browser.page_text or
-- browser.fill_form when chrome.tabs was absent for that device).
UPDATE public.feeds f
SET feed_key = CASE
        WHEN f.feed_key = 'page' THEN 'page_text'
        WHEN f.feed_key = 'fill' THEN 'fill_form'
        ELSE f.feed_key
    END,
    updated_at = now()
FROM chrome_canonical canon
WHERE f.connection_id = canon.id
  AND f.feed_key IN ('page', 'fill');

-- 5. Promote the canonical connection's connector_key to 'chrome'.
UPDATE public.connections c
SET connector_key = 'chrome',
    updated_at = now()
FROM chrome_canonical canon
WHERE c.id = canon.id;

-- 6. Soft-delete the non-canonical old connections so they drop out of
-- idx_connections_org_connector_device_live and don't shadow the
-- canonical 'chrome' row.
UPDATE public.connections c
SET deleted_at = now(),
    updated_at = now()
FROM chrome_canonical canon
WHERE c.organization_id = canon.organization_id
  AND c.device_worker_id IS NOT DISTINCT FROM canon.device_worker_id
  AND c.id <> canon.id
  AND c.deleted_at IS NULL
  AND c.connector_key IN (
        'chrome.tabs',
        'browser.evaluate',
        'browser.page_text',
        'browser.fill_form'
    );

-- 7. Update in-flight + pending runs to the new shape so the dispatcher
-- in the Chrome extension recognises them. Repoint connection_id at the
-- canonical row when the old one was soft-deleted (otherwise the worker
-- streams events tagged with a stale connection_id, and any path that
-- joins back to connections via runs.connection_id hits a deleted row).
-- Also null out connector_version so worker-api's connector_versions
-- join doesn't look up `('chrome', <old version>)`.
-- Completed/failed/cancelled runs keep the old keys for historical
-- fidelity — the worker doesn't look at them again.
UPDATE public.runs r
SET connector_key = 'chrome',
    feed_key = CASE
        WHEN r.feed_key = 'page' THEN 'page_text'
        WHEN r.feed_key = 'fill' THEN 'fill_form'
        ELSE r.feed_key
    END,
    connection_id = COALESCE(canon.id, r.connection_id),
    connector_version = NULL
FROM public.connections oldc
LEFT JOIN chrome_canonical canon
  ON canon.organization_id = oldc.organization_id
 AND canon.device_worker_id IS NOT DISTINCT FROM oldc.device_worker_id
WHERE r.connector_key IN (
        'chrome.tabs',
        'browser.evaluate',
        'browser.page_text',
        'browser.fill_form'
    )
  AND r.status IN ('pending', 'claimed', 'running')
  AND r.connection_id = oldc.id;

-- Catch any pending runs that weren't tied to one of the old
-- connections (shouldn't happen, but guards against orphaned shape).
UPDATE public.runs
SET connector_key = 'chrome',
    feed_key = CASE
        WHEN feed_key = 'page' THEN 'page_text'
        WHEN feed_key = 'fill' THEN 'fill_form'
        ELSE feed_key
    END,
    connector_version = NULL
WHERE connector_key IN (
        'chrome.tabs',
        'browser.evaluate',
        'browser.page_text',
        'browser.fill_form'
    )
  AND status IN ('pending', 'claimed', 'running');

DROP TABLE chrome_canonical;

COMMIT;

-- migrate:down

BEGIN;

-- Best-effort reversal: splitting the canonical 'chrome' connection
-- back into the original four keys is not safe without the source row
-- id mapping we don't preserve here, so we just unarchive the old
-- definitions. Connections + feeds + runs stay on the consolidated
-- shape; rolling forward to the new code (which is what production
-- expects) is the supported recovery.

UPDATE public.connector_definitions
SET status = 'active',
    updated_at = now()
WHERE key IN (
    'chrome.tabs',
    'browser.evaluate',
    'browser.page_text',
    'browser.fill_form'
)
AND status = 'archived';

COMMIT;

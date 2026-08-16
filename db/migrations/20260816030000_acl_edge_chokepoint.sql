-- migrate:up

-- A single enforcement point for authorization-bearing edges.
--
-- INERT ON ARRIVAL, deliberately. The trigger only fires for a type whose
-- `purpose` is 'authorization', and no row carries that yet — the companion
-- migration adds the column without backfilling it. This deploy therefore
-- teaches every ACL writer to set the transaction-local flag while enforcement
-- is still off. A follow-up deploy classifies `member_of`, at which point every
-- live pod already sets the flag and enforcement begins without a window in
-- which older pods' ACL syncs are rejected.
--
-- Why not call-site guards: `entity_relationships` is written by caller tools,
-- batch materializers, reconcilers, merge/unmerge, and force-delete paths.
-- Guarding a subset only ever means the NEXT writer added is the bypass, so the
-- check has to live where a caller cannot route around it.
--
-- Why not `source`: the ACL syncs write source='feed', and 'feed' is ALSO in the
-- caller-settable enum, so a caller can mint an edge that is byte-identical to a
-- sync's. Source cannot carry this boundary.
--
-- The flag is transaction-local, so it cannot leak across pooled connections
-- the way a session GUC would.

CREATE OR REPLACE FUNCTION lobu_guard_authorization_edges()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  type_id bigint;
BEGIN
  -- An UPDATE must protect both sides. Checking only NEW would let a caller move
  -- an authorization edge onto an ordinary type and thereby evade the guard.
  IF TG_OP = 'INSERT' THEN
    SELECT id INTO type_id
    FROM entity_relationship_types
    WHERE id = NEW.relationship_type_id AND purpose = 'authorization';
  ELSIF TG_OP = 'DELETE' THEN
    SELECT id INTO type_id
    FROM entity_relationship_types
    WHERE id = OLD.relationship_type_id AND purpose = 'authorization';
  ELSE
    SELECT id INTO type_id
    FROM entity_relationship_types
    WHERE id IN (OLD.relationship_type_id, NEW.relationship_type_id)
      AND purpose = 'authorization'
    LIMIT 1;
  END IF;

  IF type_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Only the ACL materializers set this, and only for the duration of their own
  -- transaction. Anything else touching a classified edge is a caller.
  IF COALESCE(current_setting('lobu.acl_write', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'relationship type % is authorization-bearing; edges on it are maintained only by the ACL syncs', type_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Re-runnable if deployment is interrupted after the function is installed.
DROP TRIGGER IF EXISTS lobu_guard_authorization_edges ON entity_relationships;

CREATE TRIGGER lobu_guard_authorization_edges
BEFORE INSERT OR UPDATE OR DELETE ON entity_relationships
FOR EACH ROW EXECUTE FUNCTION lobu_guard_authorization_edges();

-- migrate:down

DROP TRIGGER IF EXISTS lobu_guard_authorization_edges ON entity_relationships;
DROP FUNCTION IF EXISTS lobu_guard_authorization_edges();

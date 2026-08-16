-- migrate:up

-- Authorization-bearing relationship types get an explicit, system-controlled
-- classification.
--
-- The hole this closes: `member_of` is simultaneously an ACL primitive and
-- ordinary domain vocabulary, and `ensureMemberOfType` does not create-or-fail —
-- it does `ON CONFLICT (organization_id, slug) DO UPDATE`, so it ADOPTS a
-- pre-existing active row. An org defining `member_of` in its own `lobu apply`
-- schema for domain modelling would have that type silently promoted into the
-- ACL path. `created_by` cannot distinguish origin: it is NULL on the platform
-- path, and it also becomes NULL when a user is deleted.
--
-- Once ACL reads require this column (a SEPARATE, later deploy — see below), a
-- type that is not classified can never grant access, so forgetting to classify
-- fails CLOSED rather than opening a hole.
ALTER TABLE entity_relationship_types
  ADD COLUMN IF NOT EXISTS purpose text;

-- DROP first so a partially applied migration can be retried safely. NOT VALID
-- avoids validating under the ADD's stronger table lock; the separate VALIDATE
-- permits normal reads and writes while it checks the existing rows.
ALTER TABLE entity_relationship_types
  DROP CONSTRAINT IF EXISTS entity_relationship_types_purpose_check;

ALTER TABLE entity_relationship_types
  ADD CONSTRAINT entity_relationship_types_purpose_check
  CHECK (purpose IS NULL OR purpose = 'authorization') NOT VALID;

ALTER TABLE entity_relationship_types
  VALIDATE CONSTRAINT entity_relationship_types_purpose_check;

-- DELIBERATELY NOT BACKFILLED HERE. Classification is what arms the trigger, and
-- arming it in this deploy would break the ACL syncs running on pods that have
-- not yet restarted: they write member_of edges without the transaction-local
-- flag, so the trigger would reject them until the rollout drained. Every
-- trusted path that may touch ACL edges learns to set the flag while nothing is
-- classified and the trigger is inert. A follow-up deploy backfills the purpose,
-- by which point every live pod already sets the flag.

-- ROLLOUT ORDER IS LOAD-BEARING. This migration and the ACL writers that set the
-- transaction-local flag must be fully deployed BEFORE classification is
-- backfilled or ACL reads require it. During a rolling deploy an old pod can
-- still create an unclassified `member_of`; if new readers already demanded the
-- classification, that org's members would lose access until the next sync.

-- migrate:down

-- Dropping the column removes the classification the ACL reads will depend on.
-- Safe only in the direction it is written: the follow-up that adds
-- `AND rt.purpose = 'authorization'` to the three visibility gates must be rolled
-- back FIRST, or those gates match nothing and every member loses access.
ALTER TABLE entity_relationship_types
  DROP CONSTRAINT IF EXISTS entity_relationship_types_purpose_check;

ALTER TABLE entity_relationship_types
  DROP COLUMN IF EXISTS purpose;

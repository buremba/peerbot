-- `watcher_versions.skills` — the agent skills this Behavior version was built
-- from, pinned as `[{name, content}]` at save time.
--
-- Why the content is stored and not just the name: a Behavior version is a
-- freeze. `prompt` already froze the instruction text by concatenating the
-- referenced skill bodies, so the bytes were always here — just flattened into
-- one blob with the seams thrown away. Keeping the array decomposed stores the
-- same content while preserving which skill each part came from, which is what
-- makes three things possible that the blob could not:
--
--   1. Diff + upgrade. The editor can compare a pinned snapshot against the
--      agent's current skill body and offer to take the change. With only the
--      concatenated text there is nothing to diff against, so a skill edit was
--      silently invisible to every Behavior already using it.
--   2. Device dispatch. `worker-api/poll.ts` ships instructions to a device CLI
--      that has no channel back to the skill library, so it needs self-contained
--      content. A name-only reference would strand it.
--   3. Run reproducibility. The run is pinned to a version; the version now
--      pins exactly which skill text it ran, not merely which names.
--
-- Why NULL rather than a `'[]'` default: NULL means "written before this column
-- existed", i.e. a version whose instructions live wholly in `prompt`. An empty
-- array means "authored with skills, and there are none" — a real, different
-- state once the composer starts writing this column. Collapsing the two would
-- lose the ability to tell a legacy row from a deliberately skill-less one, and
-- the read paths need that distinction to decide whether `prompt` is the whole
-- instruction or just the task statement.
--
-- Nullable add with no default and no backfill: rewrite-free, so it takes only
-- a brief ACCESS EXCLUSIVE lock to update the catalog.
ALTER TABLE watcher_versions
  ADD COLUMN IF NOT EXISTS skills jsonb;

COMMENT ON COLUMN watcher_versions.skills IS
  'Pinned agent-skill snapshots for this version: [{name, content}], ordered. NULL = pre-column version whose instructions live entirely in prompt; [] = authored with skills and none selected.';

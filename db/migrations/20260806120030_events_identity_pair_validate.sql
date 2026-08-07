-- migrate:up

-- Stable THING-identity for event rows (schema part 4: validate the CHECK).
--
-- Split from 20260806120000 on purpose. There the ADD CONSTRAINT ... NOT VALID
-- takes a brief ACCESS EXCLUSIVE lock that is held until that transaction
-- commits, so validating in the same migration would run the full heap scan of
-- events while still holding AEL — a hard stall on the hottest table. In its
-- own transaction VALIDATE takes only SHARE UPDATE EXCLUSIVE: reads and writes
-- proceed while it scans. Every existing row has both columns NULL and
-- satisfies the CHECK trivially, so this cannot fail; it exists so the
-- constraint reads as validated in the catalog rather than carrying NOT VALID
-- forever.

-- Rerunnable: VALIDATE on an already-valid constraint is a no-op. squawk
-- cannot see that (or the dbmate-managed transaction), hence the ignore.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.events VALIDATE CONSTRAINT events_identity_pair;

-- migrate:down

-- Nothing to undo: validation is catalog state on a constraint that
-- 20260806120000's down migration drops.
SELECT 1;

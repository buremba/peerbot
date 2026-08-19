-- migrate:up

-- Agent CLIs a device can actually spawn for an Automation run.
--
-- Devices advertise this on every poll (`agent_kinds` in the poll body, sent by
-- the connector-worker daemon from the CLIs it can resolve on the machine), but
-- the gateway dropped it — so the automation claim lane could hand a run to a
-- device that has no `claude` installed. The device claims it and then fails it
-- with "binary not found on PATH", which reads as a broken Automation rather
-- than a machine missing a CLI.
--
-- NULL is deliberately distinct from '{}': NULL means "this device has never
-- told us" (the Mac app and the Chrome bridge today, or an older daemon) and
-- must stay claimable exactly as it is today. '{}' means "told us, and it can
-- run nothing", which is a device the lane should skip.
ALTER TABLE public.device_workers
  ADD COLUMN IF NOT EXISTS agent_kinds text[];

COMMENT ON COLUMN public.device_workers.agent_kinds IS
  'Agent CLI kinds this device can spawn for Automation runs (claude-code, codex, …), as advertised on poll. NULL = never advertised (client does not send the field; claim unrestricted); empty array = advertised none.';

-- migrate:down

ALTER TABLE public.device_workers
  DROP COLUMN IF EXISTS agent_kinds;

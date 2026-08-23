-- Snapshot the single engineering-task target onto pending Automation runs
-- queued before workspace-isolated dispatch was deployed. Runs created by the
-- new server write the same object in queue-service.ts. No schema is added: the
-- existing approved_input JSON is the durable per-run execution snapshot.
WITH task_targets AS (
  SELECT
    r.id AS run_id,
    jsonb_build_object(
      'id', min(e.id),
      'name', min(e.name),
      'entity_type', 'engineering-task',
      'metadata', min(e.metadata::text)::jsonb
    ) AS task_entity
  FROM public.runs r
  JOIN public.automations a
    ON a.id = r.automation_id
   AND a.organization_id = r.organization_id
  JOIN public.entities e
    ON e.id = ANY(a.entity_ids)
   AND e.organization_id = a.organization_id
   AND e.deleted_at IS NULL
  JOIN public.entity_types et
    ON et.id = e.entity_type_id
   AND et.organization_id = e.organization_id
   AND et.deleted_at IS NULL
  WHERE r.run_type = 'automation'
    AND r.status = 'pending'
    AND NOT (COALESCE(r.approved_input, '{}'::jsonb) ? 'task_entity')
    AND et.slug = 'engineering-task'
  GROUP BY r.id
  HAVING count(*) = 1
)
UPDATE public.runs r
SET approved_input = COALESCE(r.approved_input, '{}'::jsonb)
  || jsonb_build_object('task_entity', task_targets.task_entity)
FROM task_targets
WHERE r.id = task_targets.run_id;

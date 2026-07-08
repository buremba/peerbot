-- migrate:up

CREATE TABLE IF NOT EXISTS public.entity_approval_policies (
  id bigserial PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  entity_type_slug text NULL,
  field_path text NULL,
  create_mode text NOT NULL DEFAULT 'auto'
    CHECK (create_mode IN ('auto', 'approval')),
  update_mode text NOT NULL DEFAULT 'auto'
    CHECK (update_mode IN ('auto', 'approval')),
  delete_mode text NOT NULL DEFAULT 'approval'
    CHECK (delete_mode IN ('auto', 'approval')),
  approval_connection_id text NULL,
  approval_channel_id text NULL,
  approval_team_id text NULL,
  approval_channel_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_approval_policies_scope_key
  ON public.entity_approval_policies (
    organization_id,
    COALESCE(entity_type_slug, ''),
    COALESCE(field_path, '')
  );

CREATE INDEX IF NOT EXISTS entity_approval_policies_org_lookup
  ON public.entity_approval_policies (organization_id, entity_type_slug, field_path);

-- migrate:down

DROP TABLE IF EXISTS public.entity_approval_policies;

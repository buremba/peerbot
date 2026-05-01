\restrict M2CVBCWaQpZ2IaSZ0tLvIsiZcxaeHAXCvAhTje2jQXnlRxfcYhzgFruwfb40Hgl

-- Dumped from database version 18.1 (Debian 18.1-1.pgdg13+2)
-- Dumped by pg_dump version 18.1 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: dblink; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA public;


--
-- Name: EXTENSION dblink; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION dblink IS 'connect to other PostgreSQL databases from within a database';


--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: prevent_entity_cycles(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_entity_cycles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Skip if no parent (top-level entity)
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check for circular reference using recursive CTE (single query)
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      -- Start with the new parent
      SELECT parent_id, 1 as depth
      FROM entities
      WHERE id = NEW.parent_id

      UNION ALL

      -- Recursively walk up the tree
      SELECT e.parent_id, a.depth + 1
      FROM entities e
      INNER JOIN ancestors a ON e.id = a.parent_id
      WHERE a.depth < 10  -- Prevent infinite loops
    )
    SELECT 1
    FROM ancestors
    WHERE parent_id = NEW.id  -- Would create a cycle
       OR depth >= 10         -- Too deep
  ) THEN
    RAISE EXCEPTION 'Circular reference detected or hierarchy too deep (max 10 levels)';
  END IF;

  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: agent_channel_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_channel_bindings (
    agent_id text NOT NULL,
    platform text NOT NULL,
    channel_id text NOT NULL,
    team_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_connections (
    id text NOT NULL,
    agent_id text NOT NULL,
    platform text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_connections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'stopped'::text, 'error'::text])))
);


--
-- Name: agent_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_grants (
    id bigint NOT NULL,
    agent_id text NOT NULL,
    pattern text NOT NULL,
    expires_at timestamp with time zone,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    denied boolean DEFAULT false
);


--
-- Name: agent_grants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_grants ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_grants_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_secrets (
    name text NOT NULL,
    ciphertext text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE agent_secrets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.agent_secrets IS 'Encrypted secret values referenced via secret:// refs. Backs the PostgresSecretStore implementation of @lobu/gateway WritableSecretStore.';


--
-- Name: agent_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_users (
    agent_id text NOT NULL,
    platform text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id text NOT NULL,
    organization_id text NOT NULL,
    name text DEFAULT 'Agent'::text NOT NULL,
    description text,
    owner_platform text,
    owner_user_id text,
    template_agent_id text,
    parent_connection_id text,
    is_workspace_agent boolean DEFAULT false,
    workspace_id text,
    model text,
    model_selection jsonb DEFAULT '{}'::jsonb,
    provider_model_preferences jsonb DEFAULT '{}'::jsonb,
    network_config jsonb DEFAULT '{}'::jsonb,
    nix_config jsonb DEFAULT '{}'::jsonb,
    mcp_servers jsonb DEFAULT '{}'::jsonb,
    mcp_install_notified jsonb DEFAULT '{}'::jsonb,
    agent_integrations jsonb DEFAULT '{}'::jsonb,
    soul_md text DEFAULT ''::text,
    user_md text DEFAULT ''::text,
    identity_md text DEFAULT ''::text,
    skills_config jsonb DEFAULT '{"skills": []}'::jsonb,
    skill_auto_granted_domains jsonb DEFAULT '[]'::jsonb,
    tools_config jsonb DEFAULT '{}'::jsonb,
    plugins_config jsonb DEFAULT '{}'::jsonb,
    auth_profiles jsonb DEFAULT '[]'::jsonb,
    installed_providers jsonb DEFAULT '[]'::jsonb,
    skill_registries jsonb DEFAULT '[]'::jsonb,
    verbose_logging boolean DEFAULT false,
    egress_config jsonb DEFAULT '{}'::jsonb,
    pre_approved_tools jsonb DEFAULT '[]'::jsonb,
    guardrails jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


--
-- Name: auth_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_profiles (
    id bigint NOT NULL,
    organization_id text NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    connector_key text NOT NULL,
    profile_kind text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    auth_data jsonb DEFAULT '{}'::jsonb CONSTRAINT auth_profiles_credentials_not_null NOT NULL,
    account_id text,
    provider text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT auth_profiles_profile_kind_check CHECK ((profile_kind = ANY (ARRAY['env'::text, 'oauth_app'::text, 'oauth_account'::text, 'browser_session'::text, 'interactive'::text]))),
    CONSTRAINT auth_profiles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending_auth'::text, 'error'::text, 'revoked'::text])))
);


--
-- Name: auth_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_profiles ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.auth_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: chat_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_connections (
    id text NOT NULL,
    platform text NOT NULL,
    template_agent_id text,
    config jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_state_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_state_cache (
    key_prefix text NOT NULL,
    cache_key text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_state_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_state_lists (
    key_prefix text NOT NULL,
    list_key text NOT NULL,
    seq bigint NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: chat_state_lists_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_state_lists_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_state_lists_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_state_lists_seq_seq OWNED BY public.chat_state_lists.seq;


--
-- Name: chat_state_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_state_locks (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_state_queues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_state_queues (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    seq bigint NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: chat_state_queues_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_state_queues_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_state_queues_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_state_queues_seq_seq OWNED BY public.chat_state_queues.seq;


--
-- Name: chat_state_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_state_subscriptions (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: connect_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connect_tokens (
    id bigint NOT NULL,
    token text NOT NULL,
    connection_id bigint,
    organization_id text NOT NULL,
    connector_key text NOT NULL,
    auth_type text NOT NULL,
    auth_config jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by text,
    expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval) NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_profile_id bigint,
    CONSTRAINT connect_tokens_auth_type_check CHECK ((auth_type = ANY (ARRAY['oauth'::text, 'env_keys'::text]))),
    CONSTRAINT connect_tokens_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'expired'::text])))
);


--
-- Name: connect_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.connect_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connect_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.connect_tokens_id_seq OWNED BY public.connect_tokens.id;


--
-- Name: connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connections (
    id bigint NOT NULL,
    organization_id text NOT NULL,
    connector_key text NOT NULL,
    display_name text,
    status text DEFAULT 'active'::text NOT NULL,
    account_id text,
    credentials jsonb,
    config jsonb,
    error_message text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_profile_id bigint,
    app_auth_profile_id bigint,
    visibility text DEFAULT 'org'::text NOT NULL,
    deleted_at timestamp with time zone,
    agent_id text,
    CONSTRAINT connections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'error'::text, 'revoked'::text, 'pending_auth'::text])))
);


--
-- Name: connections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.connections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.connections_id_seq OWNED BY public.connections.id;


--
-- Name: connector_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_definitions (
    id integer NOT NULL,
    organization_id text,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    version text DEFAULT '1.0.0'::text NOT NULL,
    auth_schema jsonb,
    feeds_schema jsonb,
    actions_schema jsonb,
    options_schema jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    login_enabled boolean DEFAULT false NOT NULL,
    mcp_config jsonb,
    api_config jsonb,
    api_type text DEFAULT 'api'::text NOT NULL,
    favicon_domain text,
    openapi_config jsonb,
    default_connection_config jsonb,
    entity_link_overrides jsonb,
    default_repair_agent_id text,
    CONSTRAINT connector_definitions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'draft'::text])))
);


--
-- Name: COLUMN connector_definitions.entity_link_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connector_definitions.entity_link_overrides IS 'Per-install override of connector entityLinks rules. See resolveEntityLinkRules() for merge semantics.';


--
-- Name: connector_definitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.connector_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connector_definitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.connector_definitions_id_seq OWNED BY public.connector_definitions.id;


--
-- Name: connector_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_versions (
    id integer NOT NULL,
    connector_key text NOT NULL,
    version text NOT NULL,
    compiled_code text,
    compiled_code_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_code text,
    source_path text
);


--
-- Name: connector_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.connector_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connector_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.connector_versions_id_seq OWNED BY public.connector_versions.id;


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint CONSTRAINT event_id_not_null NOT NULL,
    organization_id text NOT NULL,
    entity_ids bigint[],
    origin_id text,
    title text,
    payload_type text DEFAULT 'text'::text NOT NULL,
    payload_text text,
    payload_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload_template jsonb,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    score numeric(10,2) DEFAULT 0,
    author_name text,
    source_url text,
    occurred_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin_parent_id text,
    origin_type text,
    connector_key text,
    connection_id bigint,
    feed_key text,
    feed_id bigint,
    run_id bigint,
    semantic_type text DEFAULT 'content'::text NOT NULL,
    client_id text,
    created_by text,
    interaction_type text DEFAULT 'none'::text NOT NULL,
    interaction_status text,
    interaction_input_schema jsonb,
    interaction_input jsonb,
    interaction_output jsonb,
    interaction_error text,
    supersedes_event_id bigint,
    content_length integer GENERATED ALWAYS AS (COALESCE(length(payload_text), 0)) STORED,
    CONSTRAINT events_interaction_status_check CHECK ((interaction_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT events_interaction_type_check CHECK ((interaction_type = ANY (ARRAY['none'::text, 'approval'::text]))),
    CONSTRAINT events_payload_type_check CHECK ((payload_type = ANY (ARRAY['text'::text, 'markdown'::text, 'json_template'::text, 'media'::text, 'empty'::text]))),
    CONSTRAINT events_semantic_type_not_empty CHECK ((length(btrim(semantic_type)) > 0))
);


--
-- Name: content_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_id_seq OWNED BY public.events.id;


--
-- Name: event_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_embeddings (
    event_id bigint NOT NULL,
    embedding public.vector(768) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: current_event_records; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_event_records AS
 SELECT e.id,
    e.organization_id,
    e.entity_ids,
    e.origin_id,
    e.title,
    e.payload_type,
    e.payload_text,
    e.payload_data,
    e.payload_template,
    e.attachments,
    e.metadata,
    e.score,
    emb.embedding,
    e.author_name,
    e.source_url,
    e.occurred_at,
    e.created_at,
    e.origin_parent_id,
    COALESCE(length(e.payload_text), 0) AS content_length,
    e.origin_type,
    e.connector_key,
    e.connection_id,
    e.feed_key,
    e.feed_id,
    e.run_id,
    e.semantic_type,
    e.client_id,
    e.created_by,
    e.interaction_type,
    e.interaction_status,
    e.interaction_input_schema,
    e.interaction_input,
    e.interaction_output,
    e.interaction_error,
    e.supersedes_event_id
   FROM (public.events e
     LEFT JOIN public.event_embeddings emb ON ((emb.event_id = e.id)))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.events newer
          WHERE (newer.supersedes_event_id = e.id))));


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id bigint NOT NULL,
    parent_id bigint,
    name text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    enabled_classifiers text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    organization_id text NOT NULL,
    created_by text NOT NULL,
    slug text NOT NULL,
    current_view_template_version_id integer,
    content text,
    embedding public.vector(768),
    content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(name, ''::text) || ' '::text) || COALESCE(content, ''::text)))) STORED,
    content_hash text,
    deleted_at timestamp with time zone,
    entity_type_id integer NOT NULL
);


--
-- Name: TABLE entities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entities IS 'Unified entity table (brands, products, and future entity types)';


--
-- Name: COLUMN entities.parent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.parent_id IS 'Hierarchical parent (products → brands, brands → parent brands)';


--
-- Name: COLUMN entities.enabled_classifiers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.enabled_classifiers IS 'Classifiers enabled for this entity (inherited from parent if NULL)';


--
-- Name: entities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entities_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entities_id_seq OWNED BY public.entities.id;


--
-- Name: entity_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_identities (
    id bigint NOT NULL,
    organization_id text NOT NULL,
    entity_id bigint NOT NULL,
    namespace text NOT NULL,
    identifier text NOT NULL,
    source_connector text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: TABLE entity_identities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_identities IS 'Normalized identifier claims per entity. See docs/identity-linking.md for the full pattern.';


--
-- Name: COLUMN entity_identities.namespace; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_identities.namespace IS 'Identifier kind. Standard values: phone, email, wa_jid, slack_user_id, github_login, auth_user_id, google_contact_id. Custom namespaces allowed but connectors sharing a namespace must agree on its format.';


--
-- Name: COLUMN entity_identities.identifier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_identities.identifier IS 'Normalized identifier value (E.164 digits for phone, lowercase for email, etc.). Normalizers in @lobu/connector-sdk own the canonical form.';


--
-- Name: COLUMN entity_identities.source_connector; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_identities.source_connector IS 'Who claimed this identifier: "connector:whatsapp", "manual", or null when seeded by migration.';


--
-- Name: entity_identities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_identities_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_identities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_identities_id_seq OWNED BY public.entity_identities.id;


--
-- Name: entity_read_grant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_read_grant (
    id text NOT NULL,
    grantor_org_id text NOT NULL,
    entity_id bigint NOT NULL,
    grantee_user_id text NOT NULL,
    scope text DEFAULT 'read-once'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    single_use boolean DEFAULT true NOT NULL,
    consumed_at timestamp with time zone,
    triggering_relationship_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_read_grant_scope_check CHECK ((scope = ANY (ARRAY['read-once'::text, 'read-n'::text, 'read-window'::text])))
);


--
-- Name: entity_relationship_type_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_relationship_type_rules (
    id integer NOT NULL,
    relationship_type_id integer NOT NULL,
    source_entity_type_slug text NOT NULL,
    target_entity_type_slug text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: entity_relationship_type_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_relationship_type_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_relationship_type_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_relationship_type_rules_id_seq OWNED BY public.entity_relationship_type_rules.id;


--
-- Name: entity_relationship_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_relationship_types (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    organization_id text NOT NULL,
    created_by text,
    metadata_schema jsonb,
    is_symmetric boolean DEFAULT false NOT NULL,
    inverse_type_id integer,
    status text DEFAULT 'active'::text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    metadata jsonb,
    CONSTRAINT entity_relationship_types_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: entity_relationship_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_relationship_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_relationship_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_relationship_types_id_seq OWNED BY public.entity_relationship_types.id;


--
-- Name: entity_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_relationships (
    id integer NOT NULL,
    organization_id text NOT NULL,
    from_entity_id bigint NOT NULL,
    to_entity_id bigint NOT NULL,
    relationship_type_id integer NOT NULL,
    metadata jsonb,
    confidence real,
    source text,
    created_by text,
    updated_by text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: entity_relationships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_relationships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_relationships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_relationships_id_seq OWNED BY public.entity_relationships.id;


--
-- Name: entity_type_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_type_audit (
    id integer NOT NULL,
    entity_type_id integer NOT NULL,
    action text NOT NULL,
    actor text,
    before_payload jsonb,
    after_payload jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT entity_type_audit_action_check CHECK ((action = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text])))
);


--
-- Name: entity_type_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_type_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_type_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_type_audit_id_seq OWNED BY public.entity_type_audit.id;


--
-- Name: entity_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_types (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    icon text,
    color text,
    metadata_schema jsonb,
    organization_id text NOT NULL,
    created_by text,
    updated_by text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    current_view_template_version_id integer,
    event_kinds jsonb
);


--
-- Name: entity_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_types_id_seq OWNED BY public.entity_types.id;


--
-- Name: event_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_classifications (
    id bigint NOT NULL,
    event_id bigint NOT NULL,
    classifier_version_id bigint NOT NULL,
    watcher_id bigint,
    window_id bigint,
    "values" text[] NOT NULL,
    confidences jsonb DEFAULT '{}'::jsonb NOT NULL,
    source character varying(20) NOT NULL,
    is_manual boolean DEFAULT false NOT NULL,
    reasoning text,
    met_threshold boolean,
    threshold numeric(5,4),
    best_match_attribute text,
    embedding_confidence numeric(6,4),
    created_at timestamp with time zone DEFAULT now(),
    excerpts jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT event_classifications_source_check CHECK (((source)::text = ANY (ARRAY[('embedding'::character varying)::text, ('llm'::character varying)::text, ('user'::character varying)::text]))),
    CONSTRAINT event_classifications_values_not_empty CHECK ((cardinality("values") > 0))
);


--
-- Name: event_classifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.event_classifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: event_classifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.event_classifications_id_seq OWNED BY public.event_classifications.id;


--
-- Name: event_classifier_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_classifier_versions (
    id integer NOT NULL,
    classifier_id integer NOT NULL,
    version integer NOT NULL,
    is_current boolean DEFAULT false,
    attribute_values jsonb NOT NULL,
    min_similarity numeric(5,4) DEFAULT 0.7,
    fallback_value text,
    change_notes text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    preferred_model text DEFAULT '@cf/meta/llama-3.1-8b-instruct'::text,
    extraction_config jsonb
);


--
-- Name: COLUMN event_classifier_versions.preferred_model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.event_classifier_versions.preferred_model IS 'AI model to use for LLM fallback. Use 8B for simple classifiers (cheap), 70B for complex reasoning (expensive). Default: 8B';


--
-- Name: event_classifier_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.event_classifier_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: event_classifier_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.event_classifier_versions_id_seq OWNED BY public.event_classifier_versions.id;


--
-- Name: event_classifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_classifiers (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    attribute_key text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by text NOT NULL,
    entity_id bigint,
    watcher_id bigint,
    organization_id text NOT NULL,
    entity_ids bigint[],
    CONSTRAINT event_classifiers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'deprecated'::text])))
);


--
-- Name: event_classifiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.event_classifiers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: event_classifiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.event_classifiers_id_seq OWNED BY public.event_classifiers.id;


--
-- Name: feeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feeds (
    id bigint NOT NULL,
    organization_id text NOT NULL,
    connection_id bigint NOT NULL,
    feed_key text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    entity_ids bigint[],
    config jsonb,
    checkpoint jsonb,
    last_sync_at timestamp with time zone,
    last_sync_status text,
    last_error text,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    items_collected bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pinned_version text,
    deleted_at timestamp with time zone,
    schedule text,
    next_run_at timestamp with time zone,
    display_name text,
    repair_agent_id text,
    repair_thread_id text,
    repair_attempt_count integer DEFAULT 0 NOT NULL,
    last_repair_at timestamp with time zone,
    first_failure_at timestamp with time zone,
    last_repair_post_hash text,
    CONSTRAINT feeds_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'error'::text])))
);


--
-- Name: feeds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feeds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feeds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feeds_id_seq OWNED BY public.feeds.id;


--
-- Name: grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grants (
    agent_id text NOT NULL,
    kind text NOT NULL,
    pattern text NOT NULL,
    expires_at timestamp with time zone,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    denied boolean DEFAULT false NOT NULL
);


--
-- Name: invitation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitation (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'member'::text,
    status text DEFAULT 'pending'::text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "inviterId" text
);


--
-- Name: latest_event_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.latest_event_classifications (
    event_id bigint NOT NULL,
    classifier_id bigint NOT NULL,
    id bigint NOT NULL,
    classifier_version_id bigint NOT NULL,
    watcher_id bigint,
    window_id bigint,
    "values" text[] NOT NULL,
    confidences jsonb DEFAULT '{}'::jsonb NOT NULL,
    source character varying(20) NOT NULL,
    is_manual boolean DEFAULT false NOT NULL,
    reasoning text,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: mcp_proxy_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_proxy_sessions (
    session_key text NOT NULL,
    upstream_session_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_sessions (
    session_id text NOT NULL,
    user_id text,
    client_id text,
    organization_id text,
    member_role text,
    requested_agent_id text,
    is_authenticated boolean DEFAULT false NOT NULL,
    scoped_to_org boolean DEFAULT false NOT NULL,
    last_accessed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: TABLE mcp_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.mcp_sessions IS 'Persisted MCP streamable HTTP sessions for restart and cross-replica recovery';


--
-- Name: member; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "userId" text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: namespace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.namespace (
    slug text NOT NULL,
    type text NOT NULL,
    ref_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT namespace_type_check CHECK ((type = ANY (ARRAY['user'::text, 'organization'::text])))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    organization_id text NOT NULL,
    user_id text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text,
    resource_type text,
    resource_id text,
    resource_url text,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: oauth_authorization_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_authorization_codes (
    code text NOT NULL,
    client_id text NOT NULL,
    user_id text NOT NULL,
    organization_id text,
    code_challenge text NOT NULL,
    code_challenge_method text DEFAULT 'S256'::text NOT NULL,
    redirect_uri text NOT NULL,
    scope text,
    state text,
    resource text,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE oauth_authorization_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.oauth_authorization_codes IS 'Short-lived authorization codes for PKCE flow';


--
-- Name: oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_clients (
    id text NOT NULL,
    client_secret text,
    client_secret_expires_at timestamp with time zone,
    client_id_issued_at timestamp with time zone DEFAULT now() NOT NULL,
    redirect_uris text[] NOT NULL,
    token_endpoint_auth_method text DEFAULT 'none'::text,
    grant_types text[] DEFAULT ARRAY['authorization_code'::text, 'refresh_token'::text],
    response_types text[] DEFAULT ARRAY['code'::text],
    client_name text,
    client_uri text,
    logo_uri text,
    scope text,
    contacts text[],
    tos_uri text,
    policy_uri text,
    software_id text,
    software_version text,
    user_id text,
    organization_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: TABLE oauth_clients; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.oauth_clients IS 'OAuth 2.1 dynamic client registration for MCP clients';


--
-- Name: oauth_device_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_device_codes (
    device_code text NOT NULL,
    user_code text NOT NULL,
    client_id text NOT NULL,
    scope text,
    resource text,
    user_id text,
    organization_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    poll_interval integer DEFAULT 5 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_device_codes_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text])))
);


--
-- Name: TABLE oauth_device_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.oauth_device_codes IS 'Device codes for OAuth Device Authorization Grant (RFC 8628)';


--
-- Name: oauth_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_states (
    id text NOT NULL,
    scope text NOT NULL,
    payload jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_tokens (
    id text NOT NULL,
    token_type text NOT NULL,
    token_hash text NOT NULL,
    client_id text NOT NULL,
    user_id text NOT NULL,
    organization_id text,
    scope text,
    resource text,
    parent_token_id text,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_tokens_token_type_check CHECK ((token_type = ANY (ARRAY['access'::text, 'refresh'::text])))
);


--
-- Name: TABLE oauth_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.oauth_tokens IS 'Access and refresh tokens issued by OAuth server';


--
-- Name: organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    metadata text,
    visibility text DEFAULT 'private'::text NOT NULL,
    description text,
    repair_agents_enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT org_slug_not_reserved CHECK ((slug <> ALL (ARRAY['settings'::text, 'auth'::text, 'api'::text, 'templates'::text, 'help'::text, 'account'::text, 'admin'::text, 'health'::text, 'login'::text, 'logout'::text, 'signup'::text, 'register'::text, 'www'::text, 'mcp'::text, 'static'::text, 'assets'::text, 'cdn'::text, 'docs'::text, 'mail'::text])))
);


--
-- Name: organization_lobu_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_lobu_links (
    organization_id text NOT NULL,
    lobu_url text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personal_access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_access_tokens (
    id bigint NOT NULL,
    token_hash text NOT NULL,
    token_prefix character varying(16) NOT NULL,
    user_id text NOT NULL,
    organization_id text,
    name text NOT NULL,
    description text,
    scope text,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE personal_access_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.personal_access_tokens IS 'Personal Access Tokens for workers, CLI tools, and MCP clients';


--
-- Name: personal_access_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.personal_access_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: personal_access_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.personal_access_tokens_id_seq OWNED BY public.personal_access_tokens.id;


--
-- Name: rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limits (
    key text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id bigint NOT NULL,
    organization_id text,
    run_type text NOT NULL,
    feed_id bigint,
    connection_id bigint,
    action_key text,
    action_input jsonb,
    action_output jsonb,
    approval_status text DEFAULT 'auto'::text,
    status text DEFAULT 'pending'::text NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    last_heartbeat_at timestamp with time zone,
    completed_at timestamp with time zone,
    connector_key text,
    connector_version text,
    checkpoint jsonb,
    items_collected integer DEFAULT 0,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    watcher_id integer,
    window_id bigint,
    approved_input jsonb,
    auth_profile_id bigint,
    auth_signal jsonb,
    created_by_user_id text,
    dispatched_message_id text,
    output_tail text,
    exit_code integer,
    exit_signal text,
    exit_reason text,
    queue_name text,
    idempotency_key text,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    retry_delay_seconds integer,
    CONSTRAINT runs_approval_status_check CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'auto'::text]))),
    CONSTRAINT runs_legacy_org_required CHECK (((run_type <> ALL (ARRAY['sync'::text, 'action'::text, 'embed_backfill'::text, 'watcher'::text, 'auth'::text])) OR (organization_id IS NOT NULL))),
    CONSTRAINT runs_run_type_check CHECK ((run_type = ANY (ARRAY['sync'::text, 'action'::text, 'embed_backfill'::text, 'watcher'::text, 'auth'::text, 'chat_message'::text, 'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text]))),
    CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'timeout'::text])))
);


--
-- Name: runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.runs_id_seq OWNED BY public.runs.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying(128) NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    "activeOrganizationId" text
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "phoneNumber" text,
    "phoneNumberVerified" boolean DEFAULT false,
    username text,
    CONSTRAINT username_not_reserved CHECK ((username <> ALL (ARRAY['settings'::text, 'auth'::text, 'api'::text, 'templates'::text, 'help'::text, 'account'::text, 'admin'::text, 'health'::text, 'login'::text, 'logout'::text, 'signup'::text, 'register'::text])))
);


--
-- Name: user_auth_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_auth_profiles (
    user_id text NOT NULL,
    agent_id text NOT NULL,
    profiles jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_model_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_model_preferences (
    user_id text NOT NULL,
    provider_id text NOT NULL,
    model text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: view_template_active_tabs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.view_template_active_tabs (
    id integer NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    organization_id text NOT NULL,
    tab_name text NOT NULL,
    tab_order integer DEFAULT 0,
    current_version_id integer NOT NULL,
    CONSTRAINT view_template_active_tabs_resource_type_check CHECK ((resource_type = ANY (ARRAY['entity_type'::text, 'entity'::text])))
);


--
-- Name: view_template_active_tabs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.view_template_active_tabs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: view_template_active_tabs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.view_template_active_tabs_id_seq OWNED BY public.view_template_active_tabs.id;


--
-- Name: view_template_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.view_template_versions (
    id integer NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    organization_id text NOT NULL,
    version integer NOT NULL,
    tab_name text,
    tab_order integer DEFAULT 0,
    json_template jsonb NOT NULL,
    change_notes text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT view_template_versions_resource_type_check CHECK ((resource_type = ANY (ARRAY['entity_type'::text, 'entity'::text])))
);


--
-- Name: view_template_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.view_template_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: view_template_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.view_template_versions_id_seq OWNED BY public.view_template_versions.id;


--
-- Name: watcher_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watcher_reactions (
    id bigint NOT NULL,
    organization_id text NOT NULL,
    watcher_id integer NOT NULL,
    window_id bigint NOT NULL,
    reaction_type text NOT NULL,
    tool_name text NOT NULL,
    tool_args jsonb,
    tool_result jsonb,
    run_id bigint,
    entity_id bigint,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: watcher_reactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.watcher_reactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watcher_reactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.watcher_reactions_id_seq OWNED BY public.watcher_reactions.id;


--
-- Name: watcher_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watcher_versions (
    id integer CONSTRAINT insight_template_versions_id_not_null NOT NULL,
    version integer CONSTRAINT insight_template_versions_version_not_null NOT NULL,
    name text CONSTRAINT insight_template_versions_name_not_null NOT NULL,
    description text,
    change_notes text,
    created_by text CONSTRAINT insight_template_versions_created_by_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    keying_config jsonb,
    json_template jsonb,
    prompt text CONSTRAINT insight_template_versions_prompt_not_null NOT NULL,
    extraction_schema jsonb CONSTRAINT insight_template_versions_extraction_schema_not_null NOT NULL,
    classifiers jsonb,
    required_source_types text[] DEFAULT '{}'::text[] CONSTRAINT insight_template_versions_required_source_types_not_null NOT NULL,
    recommended_source_types text[] DEFAULT '{}'::text[] CONSTRAINT insight_template_versions_recommended_source_types_not_null NOT NULL,
    reactions_guidance text,
    condensation_prompt text,
    condensation_window_count integer DEFAULT 4,
    watcher_id integer,
    version_sources jsonb
);


--
-- Name: COLUMN watcher_versions.json_template; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_versions.json_template IS 'JSON-based template definition for React rendering. Replaces Svelte-based renderer_component.';


--
-- Name: COLUMN watcher_versions.prompt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_versions.prompt IS 'Handlebars prompt template used for insight extraction.';


--
-- Name: COLUMN watcher_versions.extraction_schema; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_versions.extraction_schema IS 'JSON Schema defining LLM output structure for this template version.';


--
-- Name: COLUMN watcher_versions.classifiers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_versions.classifiers IS 'Optional classifier definitions attached to this template version.';


--
-- Name: COLUMN watcher_versions.required_source_types; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_versions.required_source_types IS 'Source type slugs that must exist for selected source entities before insight creation.';


--
-- Name: COLUMN watcher_versions.recommended_source_types; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_versions.recommended_source_types IS 'Source type slugs recommended for better insight quality.';


--
-- Name: COLUMN watcher_versions.reactions_guidance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_versions.reactions_guidance IS 'Optional guidance text for LLM agents on what reactions to take after analyzing a watcher window.';


--
-- Name: COLUMN watcher_versions.condensation_prompt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_versions.condensation_prompt IS 'Handlebars prompt for condensing completed windows into a rollup. Receives {{windows}} array.';


--
-- Name: COLUMN watcher_versions.condensation_window_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_versions.condensation_window_count IS 'How many leaf windows to condense into one rollup. Default 4.';


--
-- Name: watcher_template_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.watcher_template_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watcher_template_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.watcher_template_versions_id_seq OWNED BY public.watcher_versions.id;


--
-- Name: watcher_window_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watcher_window_events (
    id bigint CONSTRAINT insight_window_content_id_not_null NOT NULL,
    window_id bigint CONSTRAINT insight_window_content_window_id_not_null NOT NULL,
    event_id bigint CONSTRAINT insight_window_content_content_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: watcher_window_content_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.watcher_window_content_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watcher_window_content_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.watcher_window_content_id_seq OWNED BY public.watcher_window_events.id;


--
-- Name: watcher_window_field_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watcher_window_field_feedback (
    id bigint NOT NULL,
    window_id integer NOT NULL,
    watcher_id integer NOT NULL,
    organization_id text NOT NULL,
    field_path text NOT NULL,
    mutation text DEFAULT 'set'::text NOT NULL,
    corrected_value jsonb,
    note text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT watcher_window_field_feedback_mutation_check CHECK ((mutation = ANY (ARRAY['set'::text, 'remove'::text, 'add'::text])))
);


--
-- Name: watcher_window_field_feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.watcher_window_field_feedback_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watcher_window_field_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.watcher_window_field_feedback_id_seq OWNED BY public.watcher_window_field_feedback.id;


--
-- Name: watcher_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watcher_windows (
    id integer CONSTRAINT insight_windows_id_not_null NOT NULL,
    watcher_id integer CONSTRAINT insight_windows_insight_id_not_null NOT NULL,
    parent_window_id integer,
    granularity text CONSTRAINT insight_windows_granularity_not_null NOT NULL,
    window_start timestamp with time zone CONSTRAINT insight_windows_window_start_not_null NOT NULL,
    window_end timestamp with time zone CONSTRAINT insight_windows_window_end_not_null NOT NULL,
    content_analyzed integer CONSTRAINT insight_windows_content_analyzed_not_null NOT NULL,
    extracted_data jsonb CONSTRAINT insight_windows_extracted_data_not_null NOT NULL,
    model_used text,
    execution_time_ms integer,
    is_rollup boolean DEFAULT false,
    source_window_ids integer[],
    created_at timestamp with time zone DEFAULT now(),
    version_id integer,
    depth integer DEFAULT 0,
    client_id text,
    run_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    run_id bigint
);


--
-- Name: TABLE watcher_windows; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.watcher_windows IS 'Time-series watcher results with hierarchical rollups';


--
-- Name: COLUMN watcher_windows.parent_window_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_windows.parent_window_id IS 'Rollup hierarchy (daily->weekly->monthly->quarterly)';


--
-- Name: COLUMN watcher_windows.depth; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watcher_windows.depth IS 'Condensation depth: 0=leaf, 1+=rollup tiers';


--
-- Name: watcher_windows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.watcher_windows_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watcher_windows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.watcher_windows_id_seq OWNED BY public.watcher_windows.id;


--
-- Name: watchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watchers (
    id integer CONSTRAINT insights_id_not_null NOT NULL,
    model_config jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sources jsonb DEFAULT '[]'::jsonb,
    created_by text CONSTRAINT insights_created_by_not_null NOT NULL,
    entity_ids bigint[],
    reaction_script text,
    reaction_script_compiled text,
    organization_id text NOT NULL,
    name text,
    slug text,
    description text,
    version integer DEFAULT 1,
    tags text[] DEFAULT '{}'::text[],
    current_version_id integer,
    schedule text,
    next_run_at timestamp with time zone,
    agent_id text,
    connection_id text,
    scheduler_client_id text,
    source_watcher_id integer,
    watcher_group_id integer NOT NULL,
    CONSTRAINT insights_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: COLUMN watchers.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watchers.status IS 'Status of insight: active (recurring), paused (recurring), failed (recurring), completed (one-off)';


--
-- Name: COLUMN watchers.sources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watchers.sources IS 'Array of data sources: [{name: string, entity_id: number, filters: {min_score?, platforms?, search_query?}}]. Each source defines an entity and its filters for content fetching.';


--
-- Name: COLUMN watchers.reaction_script; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watchers.reaction_script IS 'TypeScript source for automated reaction script.';


--
-- Name: COLUMN watchers.reaction_script_compiled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.watchers.reaction_script_compiled IS 'Compiled JavaScript from reaction_script.';


--
-- Name: watchers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.watchers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watchers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.watchers_id_seq OWNED BY public.watchers.id;


--
-- Name: chat_state_lists seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_state_lists ALTER COLUMN seq SET DEFAULT nextval('public.chat_state_lists_seq_seq'::regclass);


--
-- Name: chat_state_queues seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_state_queues ALTER COLUMN seq SET DEFAULT nextval('public.chat_state_queues_seq_seq'::regclass);


--
-- Name: connect_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connect_tokens ALTER COLUMN id SET DEFAULT nextval('public.connect_tokens_id_seq'::regclass);


--
-- Name: connections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections ALTER COLUMN id SET DEFAULT nextval('public.connections_id_seq'::regclass);


--
-- Name: connector_definitions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_definitions ALTER COLUMN id SET DEFAULT nextval('public.connector_definitions_id_seq'::regclass);


--
-- Name: connector_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_versions ALTER COLUMN id SET DEFAULT nextval('public.connector_versions_id_seq'::regclass);


--
-- Name: entities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities ALTER COLUMN id SET DEFAULT nextval('public.entities_id_seq'::regclass);


--
-- Name: entity_identities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_identities ALTER COLUMN id SET DEFAULT nextval('public.entity_identities_id_seq'::regclass);


--
-- Name: entity_relationship_type_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationship_type_rules ALTER COLUMN id SET DEFAULT nextval('public.entity_relationship_type_rules_id_seq'::regclass);


--
-- Name: entity_relationship_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationship_types ALTER COLUMN id SET DEFAULT nextval('public.entity_relationship_types_id_seq'::regclass);


--
-- Name: entity_relationships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships ALTER COLUMN id SET DEFAULT nextval('public.entity_relationships_id_seq'::regclass);


--
-- Name: entity_type_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_type_audit ALTER COLUMN id SET DEFAULT nextval('public.entity_type_audit_id_seq'::regclass);


--
-- Name: entity_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_types ALTER COLUMN id SET DEFAULT nextval('public.entity_types_id_seq'::regclass);


--
-- Name: event_classifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifications ALTER COLUMN id SET DEFAULT nextval('public.event_classifications_id_seq'::regclass);


--
-- Name: event_classifier_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifier_versions ALTER COLUMN id SET DEFAULT nextval('public.event_classifier_versions_id_seq'::regclass);


--
-- Name: event_classifiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifiers ALTER COLUMN id SET DEFAULT nextval('public.event_classifiers_id_seq'::regclass);


--
-- Name: events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events ALTER COLUMN id SET DEFAULT nextval('public.content_id_seq'::regclass);


--
-- Name: feeds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeds ALTER COLUMN id SET DEFAULT nextval('public.feeds_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: personal_access_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens ALTER COLUMN id SET DEFAULT nextval('public.personal_access_tokens_id_seq'::regclass);


--
-- Name: runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs ALTER COLUMN id SET DEFAULT nextval('public.runs_id_seq'::regclass);


--
-- Name: view_template_active_tabs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_template_active_tabs ALTER COLUMN id SET DEFAULT nextval('public.view_template_active_tabs_id_seq'::regclass);


--
-- Name: view_template_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_template_versions ALTER COLUMN id SET DEFAULT nextval('public.view_template_versions_id_seq'::regclass);


--
-- Name: watcher_reactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_reactions ALTER COLUMN id SET DEFAULT nextval('public.watcher_reactions_id_seq'::regclass);


--
-- Name: watcher_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_versions ALTER COLUMN id SET DEFAULT nextval('public.watcher_template_versions_id_seq'::regclass);


--
-- Name: watcher_window_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_window_events ALTER COLUMN id SET DEFAULT nextval('public.watcher_window_content_id_seq'::regclass);


--
-- Name: watcher_window_field_feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_window_field_feedback ALTER COLUMN id SET DEFAULT nextval('public.watcher_window_field_feedback_id_seq'::regclass);


--
-- Name: watcher_windows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_windows ALTER COLUMN id SET DEFAULT nextval('public.watcher_windows_id_seq'::regclass);


--
-- Name: watchers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchers ALTER COLUMN id SET DEFAULT nextval('public.watchers_id_seq'::regclass);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: agent_channel_bindings agent_channel_bindings_platform_channel_id_team_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_channel_bindings
    ADD CONSTRAINT agent_channel_bindings_platform_channel_id_team_id_key UNIQUE (platform, channel_id, team_id);


--
-- Name: agent_connections agent_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_connections
    ADD CONSTRAINT agent_connections_pkey PRIMARY KEY (id);


--
-- Name: agent_grants agent_grants_agent_id_pattern_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_agent_id_pattern_key UNIQUE (agent_id, pattern);


--
-- Name: agent_grants agent_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_pkey PRIMARY KEY (id);


--
-- Name: agent_secrets agent_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_secrets
    ADD CONSTRAINT agent_secrets_pkey PRIMARY KEY (name);


--
-- Name: agent_users agent_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_users
    ADD CONSTRAINT agent_users_pkey PRIMARY KEY (agent_id, platform, user_id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: auth_profiles auth_profiles_org_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_profiles
    ADD CONSTRAINT auth_profiles_org_id_unique UNIQUE (organization_id, id);


--
-- Name: auth_profiles auth_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_profiles
    ADD CONSTRAINT auth_profiles_pkey PRIMARY KEY (id);


--
-- Name: chat_connections chat_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_connections
    ADD CONSTRAINT chat_connections_pkey PRIMARY KEY (id);


--
-- Name: chat_state_cache chat_state_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_state_cache
    ADD CONSTRAINT chat_state_cache_pkey PRIMARY KEY (key_prefix, cache_key);


--
-- Name: chat_state_lists chat_state_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_state_lists
    ADD CONSTRAINT chat_state_lists_pkey PRIMARY KEY (key_prefix, list_key, seq);


--
-- Name: chat_state_locks chat_state_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_state_locks
    ADD CONSTRAINT chat_state_locks_pkey PRIMARY KEY (key_prefix, thread_id);


--
-- Name: chat_state_queues chat_state_queues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_state_queues
    ADD CONSTRAINT chat_state_queues_pkey PRIMARY KEY (key_prefix, thread_id, seq);


--
-- Name: chat_state_subscriptions chat_state_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_state_subscriptions
    ADD CONSTRAINT chat_state_subscriptions_pkey PRIMARY KEY (key_prefix, thread_id);


--
-- Name: connect_tokens connect_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connect_tokens
    ADD CONSTRAINT connect_tokens_pkey PRIMARY KEY (id);


--
-- Name: connect_tokens connect_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connect_tokens
    ADD CONSTRAINT connect_tokens_token_key UNIQUE (token);


--
-- Name: connections connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);


--
-- Name: connector_definitions connector_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_definitions
    ADD CONSTRAINT connector_definitions_pkey PRIMARY KEY (id);


--
-- Name: connector_versions connector_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_versions
    ADD CONSTRAINT connector_versions_pkey PRIMARY KEY (id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entity_identities entity_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_identities
    ADD CONSTRAINT entity_identities_pkey PRIMARY KEY (id);


--
-- Name: entity_read_grant entity_read_grant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_read_grant
    ADD CONSTRAINT entity_read_grant_pkey PRIMARY KEY (id);


--
-- Name: entity_relationship_type_rules entity_relationship_type_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationship_type_rules
    ADD CONSTRAINT entity_relationship_type_rules_pkey PRIMARY KEY (id);


--
-- Name: entity_relationship_types entity_relationship_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationship_types
    ADD CONSTRAINT entity_relationship_types_pkey PRIMARY KEY (id);


--
-- Name: entity_relationships entity_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_pkey PRIMARY KEY (id);


--
-- Name: entity_type_audit entity_type_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_type_audit
    ADD CONSTRAINT entity_type_audit_pkey PRIMARY KEY (id);


--
-- Name: entity_types entity_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_types
    ADD CONSTRAINT entity_types_pkey PRIMARY KEY (id);


--
-- Name: event_classifications event_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifications
    ADD CONSTRAINT event_classifications_pkey PRIMARY KEY (id);


--
-- Name: event_classifier_versions event_classifier_versions_classifier_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifier_versions
    ADD CONSTRAINT event_classifier_versions_classifier_id_version_key UNIQUE (classifier_id, version);


--
-- Name: event_classifier_versions event_classifier_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifier_versions
    ADD CONSTRAINT event_classifier_versions_pkey PRIMARY KEY (id);


--
-- Name: event_classifiers event_classifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifiers
    ADD CONSTRAINT event_classifiers_pkey PRIMARY KEY (id);


--
-- Name: event_classifiers event_classifiers_unique_per_insight; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifiers
    ADD CONSTRAINT event_classifiers_unique_per_insight UNIQUE NULLS NOT DISTINCT (entity_id, watcher_id, slug);


--
-- Name: event_embeddings event_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_embeddings
    ADD CONSTRAINT event_embeddings_pkey PRIMARY KEY (event_id);


--
-- Name: events event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT event_pkey PRIMARY KEY (id);


--
-- Name: feeds feeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeds
    ADD CONSTRAINT feeds_pkey PRIMARY KEY (id);


--
-- Name: grants grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grants
    ADD CONSTRAINT grants_pkey PRIMARY KEY (agent_id, kind, pattern);


--
-- Name: watcher_versions insight_template_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_versions
    ADD CONSTRAINT insight_template_versions_pkey PRIMARY KEY (id);


--
-- Name: watcher_window_events insight_window_content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_window_events
    ADD CONSTRAINT insight_window_content_pkey PRIMARY KEY (id);


--
-- Name: watcher_window_events insight_window_content_window_id_content_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_window_events
    ADD CONSTRAINT insight_window_content_window_id_content_id_key UNIQUE (window_id, event_id);


--
-- Name: watcher_windows insight_windows_insight_id_granularity_window_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_windows
    ADD CONSTRAINT insight_windows_insight_id_granularity_window_start_key UNIQUE (watcher_id, granularity, window_start);


--
-- Name: watcher_windows insight_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_windows
    ADD CONSTRAINT insight_windows_pkey PRIMARY KEY (id);


--
-- Name: watchers insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchers
    ADD CONSTRAINT insights_pkey PRIMARY KEY (id);


--
-- Name: invitation invitation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT invitation_pkey PRIMARY KEY (id);


--
-- Name: latest_event_classifications latest_event_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.latest_event_classifications
    ADD CONSTRAINT latest_event_classifications_pkey PRIMARY KEY (event_id, classifier_id);


--
-- Name: mcp_proxy_sessions mcp_proxy_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_proxy_sessions
    ADD CONSTRAINT mcp_proxy_sessions_pkey PRIMARY KEY (session_key);


--
-- Name: mcp_sessions mcp_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_sessions
    ADD CONSTRAINT mcp_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: member member_organizationId_userId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT "member_organizationId_userId_key" UNIQUE ("organizationId", "userId");


--
-- Name: member member_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (id);


--
-- Name: namespace namespace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.namespace
    ADD CONSTRAINT namespace_pkey PRIMARY KEY (slug);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: oauth_authorization_codes oauth_authorization_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_pkey PRIMARY KEY (code);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);


--
-- Name: oauth_device_codes oauth_device_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_device_codes
    ADD CONSTRAINT oauth_device_codes_pkey PRIMARY KEY (device_code);


--
-- Name: oauth_states oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_pkey PRIMARY KEY (id);


--
-- Name: oauth_tokens oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (id);


--
-- Name: oauth_tokens oauth_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: organization_lobu_links organization_lobu_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_lobu_links
    ADD CONSTRAINT organization_lobu_links_pkey PRIMARY KEY (organization_id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_slug_key UNIQUE (slug);


--
-- Name: personal_access_tokens personal_access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_pkey PRIMARY KEY (id);


--
-- Name: personal_access_tokens personal_access_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: rate_limits rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (key);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user_auth_profiles user_auth_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_auth_profiles
    ADD CONSTRAINT user_auth_profiles_pkey PRIMARY KEY (user_id, agent_id);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user_model_preferences user_model_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_model_preferences
    ADD CONSTRAINT user_model_preferences_pkey PRIMARY KEY (user_id, provider_id);


--
-- Name: user user_phoneNumber_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT "user_phoneNumber_key" UNIQUE ("phoneNumber");


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: view_template_active_tabs view_template_active_tabs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_template_active_tabs
    ADD CONSTRAINT view_template_active_tabs_pkey PRIMARY KEY (id);


--
-- Name: view_template_active_tabs view_template_active_tabs_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_template_active_tabs
    ADD CONSTRAINT view_template_active_tabs_unique UNIQUE (resource_type, resource_id, organization_id, tab_name);


--
-- Name: view_template_versions view_template_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_template_versions
    ADD CONSTRAINT view_template_versions_pkey PRIMARY KEY (id);


--
-- Name: view_template_versions view_template_versions_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_template_versions
    ADD CONSTRAINT view_template_versions_unique UNIQUE NULLS NOT DISTINCT (resource_type, resource_id, organization_id, tab_name, version);


--
-- Name: watcher_reactions watcher_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_reactions
    ADD CONSTRAINT watcher_reactions_pkey PRIMARY KEY (id);


--
-- Name: watcher_window_field_feedback watcher_window_field_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_window_field_feedback
    ADD CONSTRAINT watcher_window_field_feedback_pkey PRIMARY KEY (id);


--
-- Name: account_providerId_accountId_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON public.account USING btree ("providerId", "accountId");


--
-- Name: account_providerId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "account_providerId_idx" ON public.account USING btree ("providerId");


--
-- Name: account_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "account_userId_idx" ON public.account USING btree ("userId");


--
-- Name: agent_channel_bindings_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_channel_bindings_agent_id_idx ON public.agent_channel_bindings USING btree (agent_id);


--
-- Name: agent_channel_bindings_no_team_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_channel_bindings_no_team_unique ON public.agent_channel_bindings USING btree (platform, channel_id) WHERE (team_id IS NULL);


--
-- Name: agent_connections_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_connections_agent_id_idx ON public.agent_connections USING btree (agent_id);


--
-- Name: agent_connections_platform_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_connections_platform_idx ON public.agent_connections USING btree (platform);


--
-- Name: agent_grants_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_grants_agent_id_idx ON public.agent_grants USING btree (agent_id);


--
-- Name: agent_secrets_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_secrets_expires_at_idx ON public.agent_secrets USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: agent_secrets_name_prefix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_secrets_name_prefix_idx ON public.agent_secrets USING btree (name text_pattern_ops);


--
-- Name: agents_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_organization_id_idx ON public.agents USING btree (organization_id);


--
-- Name: agents_parent_connection_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_parent_connection_id_idx ON public.agents USING btree (parent_connection_id);


--
-- Name: agents_template_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_template_agent_id_idx ON public.agents USING btree (template_agent_id);


--
-- Name: auth_profiles_connector_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_profiles_connector_kind_idx ON public.auth_profiles USING btree (organization_id, connector_key, profile_kind, status);


--
-- Name: auth_profiles_org_slug_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_profiles_org_slug_unique ON public.auth_profiles USING btree (organization_id, slug);


--
-- Name: auth_profiles_pending_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_profiles_pending_unique ON public.auth_profiles USING btree (organization_id, connector_key, profile_kind, provider) WHERE (status = 'pending_auth'::text);


--
-- Name: chat_connections_platform_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_connections_platform_idx ON public.chat_connections USING btree (platform);


--
-- Name: chat_connections_template_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_connections_template_agent_id_idx ON public.chat_connections USING btree (template_agent_id) WHERE (template_agent_id IS NOT NULL);


--
-- Name: chat_state_cache_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_state_cache_expires_idx ON public.chat_state_cache USING btree (expires_at);


--
-- Name: chat_state_lists_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_state_lists_expires_idx ON public.chat_state_lists USING btree (expires_at);


--
-- Name: chat_state_locks_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_state_locks_expires_idx ON public.chat_state_locks USING btree (expires_at);


--
-- Name: chat_state_queues_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_state_queues_expires_idx ON public.chat_state_queues USING btree (expires_at);


--
-- Name: entities_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_slug_idx ON public.entities USING btree (slug);


--
-- Name: entities_slug_parent_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entities_slug_parent_unique ON public.entities USING btree (organization_id, COALESCE(parent_id, (0)::bigint), slug);


--
-- Name: feeds_open_repair_thread_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX feeds_open_repair_thread_uniq ON public.feeds USING btree (id) WHERE (repair_thread_id IS NOT NULL);


--
-- Name: grants_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grants_agent_id_idx ON public.grants USING btree (agent_id);


--
-- Name: grants_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grants_expires_at_idx ON public.grants USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_cc_classifier_version_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_classifier_version_id ON public.event_classifications USING btree (classifier_version_id);


--
-- Name: idx_cc_content_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_content_id ON public.event_classifications USING btree (event_id);


--
-- Name: idx_cc_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_source ON public.event_classifications USING btree (source);


--
-- Name: idx_cc_unique_per_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cc_unique_per_source ON public.event_classifications USING btree (event_id, classifier_version_id, source, COALESCE(watcher_id, (0)::bigint));


--
-- Name: idx_cc_values_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_values_gin ON public.event_classifications USING gin ("values");


--
-- Name: idx_cc_watcher_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_watcher_id ON public.event_classifications USING btree (watcher_id) WHERE (watcher_id IS NOT NULL);


--
-- Name: idx_cc_window_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_window_id ON public.event_classifications USING btree (window_id) WHERE (window_id IS NOT NULL);


--
-- Name: idx_connect_tokens_connection_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connect_tokens_connection_id ON public.connect_tokens USING btree (connection_id);


--
-- Name: idx_connect_tokens_status_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connect_tokens_status_expires ON public.connect_tokens USING btree (status, expires_at) WHERE (status = 'pending'::text);


--
-- Name: idx_connect_tokens_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connect_tokens_token ON public.connect_tokens USING btree (token);


--
-- Name: idx_connections_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connections_account ON public.connections USING btree (account_id);


--
-- Name: idx_connections_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connections_agent_id ON public.connections USING btree (agent_id) WHERE (agent_id IS NOT NULL);


--
-- Name: idx_connections_connector_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connections_connector_key ON public.connections USING btree (connector_key);


--
-- Name: idx_connections_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connections_deleted_at ON public.connections USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_connections_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connections_org ON public.connections USING btree (organization_id);


--
-- Name: idx_connections_org_connector_account_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connections_org_connector_account_live ON public.connections USING btree (organization_id, connector_key, account_id) WHERE ((deleted_at IS NULL) AND (account_id IS NOT NULL));


--
-- Name: idx_connections_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connections_status ON public.connections USING btree (status);


--
-- Name: idx_connections_visibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connections_visibility ON public.connections USING btree (organization_id, visibility);


--
-- Name: idx_connector_defs_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connector_defs_org_key ON public.connector_definitions USING btree (organization_id, key) WHERE ((organization_id IS NOT NULL) AND (status = 'active'::text));


--
-- Name: idx_connector_defs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_defs_status ON public.connector_definitions USING btree (status);


--
-- Name: idx_connector_defs_system_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connector_defs_system_key ON public.connector_definitions USING btree (key) WHERE ((organization_id IS NULL) AND (status = 'active'::text));


--
-- Name: idx_connector_versions_key_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connector_versions_key_version ON public.connector_versions USING btree (connector_key, version);


--
-- Name: idx_ec_has_excerpts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ec_has_excerpts ON public.event_classifications USING btree (((excerpts <> '{}'::jsonb))) WHERE (excerpts <> '{}'::jsonb);


--
-- Name: idx_entities_by_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_by_parent ON public.entities USING btree (parent_id, id) WHERE (parent_id IS NOT NULL);


--
-- Name: idx_entities_classifiers; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_classifiers ON public.entities USING gin (enabled_classifiers) WHERE (enabled_classifiers IS NOT NULL);


--
-- Name: idx_entities_content_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_content_hash ON public.entities USING btree (organization_id, content_hash) WHERE ((content_hash IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_entities_content_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_content_tsv ON public.entities USING gin (content_tsv) WHERE (deleted_at IS NULL);


--
-- Name: idx_entities_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_created_by ON public.entities USING btree (created_by);


--
-- Name: idx_entities_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_embedding ON public.entities USING ivfflat (embedding public.vector_cosine_ops) WITH (lists='100') WHERE ((embedding IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_entities_entity_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_entity_type_id ON public.entities USING btree (entity_type_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_entities_metadata_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_entities_metadata_domain ON public.entities USING btree (((metadata ->> 'domain'::text)), organization_id) WHERE ((metadata ->> 'domain'::text) IS NOT NULL);


--
-- Name: idx_entities_metadata_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_metadata_email ON public.entities USING btree (((metadata ->> 'email'::text)), organization_id) WHERE (((metadata ->> 'email'::text) IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_entities_metadata_github_handle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_metadata_github_handle ON public.entities USING btree (((metadata ->> 'github_handle'::text)), organization_id) WHERE (((metadata ->> 'github_handle'::text) IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_entities_metadata_linkedin_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_metadata_linkedin_url ON public.entities USING btree (((metadata ->> 'linkedin_url'::text)), organization_id) WHERE (((metadata ->> 'linkedin_url'::text) IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_entities_metadata_twitter_handle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_metadata_twitter_handle ON public.entities USING btree (((metadata ->> 'twitter_handle'::text)), organization_id) WHERE (((metadata ->> 'twitter_handle'::text) IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_entities_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_name ON public.entities USING btree (lower(name));


--
-- Name: idx_entities_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_organization_id ON public.entities USING btree (organization_id);


--
-- Name: idx_entity_identities_by_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_identities_by_entity ON public.entity_identities USING btree (entity_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_entity_identities_live_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_entity_identities_live_unique ON public.entity_identities USING btree (organization_id, namespace, identifier) WHERE (deleted_at IS NULL);


--
-- Name: idx_entity_identities_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_identities_lookup ON public.entity_identities USING btree (organization_id, namespace, identifier) WHERE (deleted_at IS NULL);


--
-- Name: idx_entity_read_grant_entity_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_read_grant_entity_active ON public.entity_read_grant USING btree (entity_id, expires_at) WHERE (consumed_at IS NULL);


--
-- Name: idx_entity_read_grant_grantee_entity_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_read_grant_grantee_entity_active ON public.entity_read_grant USING btree (grantee_user_id, entity_id, expires_at) WHERE (consumed_at IS NULL);


--
-- Name: idx_entity_read_grant_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_entity_read_grant_idempotency ON public.entity_read_grant USING btree (grantor_org_id, entity_id, grantee_user_id, triggering_relationship_id) WHERE (consumed_at IS NULL);


--
-- Name: idx_entity_rel_type_rules_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_rel_type_rules_type ON public.entity_relationship_type_rules USING btree (relationship_type_id);


--
-- Name: idx_entity_rel_types_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_entity_rel_types_org_slug ON public.entity_relationship_types USING btree (organization_id, slug) WHERE (status = 'active'::text);


--
-- Name: idx_entity_relationship_types_has_auto_create; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_relationship_types_has_auto_create ON public.entity_relationship_types USING btree (((metadata -> 'autoCreateWhen'::text))) WHERE ((metadata ? 'autoCreateWhen'::text) AND (deleted_at IS NULL));


--
-- Name: idx_entity_relationships_derived_from_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_relationships_derived_from_event ON public.entity_relationships USING btree ((((metadata -> 'derivedFrom'::text) ->> 'sourceEventId'::text))) WHERE (metadata ? 'derivedFrom'::text);


--
-- Name: idx_entity_relationships_derived_from_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_relationships_derived_from_rule ON public.entity_relationships USING btree ((((metadata -> 'derivedFrom'::text) ->> 'relationshipTypeId'::text)), (((metadata -> 'derivedFrom'::text) ->> 'ruleVersion'::text))) WHERE (metadata ? 'derivedFrom'::text);


--
-- Name: idx_entity_relationships_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_relationships_from ON public.entity_relationships USING btree (from_entity_id);


--
-- Name: idx_entity_relationships_live_triple; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_entity_relationships_live_triple ON public.entity_relationships USING btree (from_entity_id, to_entity_id, relationship_type_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_entity_relationships_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_relationships_org ON public.entity_relationships USING btree (organization_id);


--
-- Name: idx_entity_relationships_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_relationships_to ON public.entity_relationships USING btree (to_entity_id);


--
-- Name: idx_entity_relationships_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_relationships_type ON public.entity_relationships USING btree (relationship_type_id);


--
-- Name: idx_entity_type_audit_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_type_audit_action ON public.entity_type_audit USING btree (action);


--
-- Name: idx_entity_type_audit_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_type_audit_type_id ON public.entity_type_audit USING btree (entity_type_id);


--
-- Name: idx_entity_types_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_types_active ON public.entity_types USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_entity_types_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_entity_types_org_slug ON public.entity_types USING btree (organization_id, slug) WHERE ((organization_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_event_classifications_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifications_source ON public.event_classifications USING btree (source);


--
-- Name: idx_event_classifier_versions_classifier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifier_versions_classifier ON public.event_classifier_versions USING btree (classifier_id);


--
-- Name: idx_event_classifier_versions_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifier_versions_created_by ON public.event_classifier_versions USING btree (created_by);


--
-- Name: idx_event_classifier_versions_current; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_event_classifier_versions_current ON public.event_classifier_versions USING btree (classifier_id) WHERE (is_current = true);


--
-- Name: idx_event_classifiers_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifiers_created_by ON public.event_classifiers USING btree (created_by);


--
-- Name: idx_event_classifiers_entity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifiers_entity_id ON public.event_classifiers USING btree (entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: idx_event_classifiers_entity_ids; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifiers_entity_ids ON public.event_classifiers USING gin (entity_ids);


--
-- Name: idx_event_classifiers_insight_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifiers_insight_id ON public.event_classifiers USING btree (watcher_id) WHERE (watcher_id IS NOT NULL);


--
-- Name: idx_event_classifiers_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifiers_organization_id ON public.event_classifiers USING btree (organization_id);


--
-- Name: idx_event_classifiers_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifiers_slug ON public.event_classifiers USING btree (slug);


--
-- Name: idx_event_classifiers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_classifiers_status ON public.event_classifiers USING btree (status);


--
-- Name: idx_events_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_client_id ON public.events USING btree (client_id) WHERE (client_id IS NOT NULL);


--
-- Name: idx_events_connection_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_connection_id ON public.events USING btree (connection_id);


--
-- Name: idx_events_connection_origin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_connection_origin_id ON public.events USING btree (connection_id, origin_id, created_at DESC) WHERE (connection_id IS NOT NULL);


--
-- Name: idx_events_connector_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_connector_key ON public.events USING btree (connector_key);


--
-- Name: idx_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_created_at ON public.events USING btree (created_at);


--
-- Name: idx_events_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_created_by ON public.events USING btree (created_by) WHERE (created_by IS NOT NULL);


--
-- Name: idx_events_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_embedding ON public.event_embeddings USING ivfflat (embedding public.vector_cosine_ops) WITH (lists='1000');


--
-- Name: idx_events_entity_ids; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_entity_ids ON public.events USING gin (entity_ids);


--
-- Name: idx_events_entity_ids_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_entity_ids_occurred_at ON public.events USING btree ((entity_ids[1]), occurred_at DESC, id DESC) WHERE ((entity_ids IS NOT NULL) AND (entity_ids <> '{}'::bigint[]));


--
-- Name: idx_events_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_feed_id ON public.events USING btree (feed_id);


--
-- Name: idx_events_fulltext; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_fulltext ON public.events USING gin (to_tsvector('english'::regconfig, COALESCE(payload_text, ''::text)));


--
-- Name: idx_events_identity_fact_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_identity_fact_account ON public.events USING btree (connector_key, ((metadata ->> 'providerStableId'::text)), ((metadata ->> 'namespace'::text))) WHERE (semantic_type = 'identity_fact'::text);


--
-- Name: idx_events_identity_fact_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_identity_fact_lookup ON public.events USING btree (organization_id, ((metadata ->> 'namespace'::text)), ((metadata ->> 'normalizedValue'::text))) WHERE (semantic_type = 'identity_fact'::text);


--
-- Name: idx_events_metadata_auth_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_metadata_auth_user_id ON public.events USING btree (((metadata ->> 'auth_user_id'::text))) WHERE (metadata ? 'auth_user_id'::text);


--
-- Name: idx_events_metadata_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_metadata_email ON public.events USING btree (((metadata ->> 'email'::text))) WHERE (metadata ? 'email'::text);


--
-- Name: idx_events_metadata_github_login; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_metadata_github_login ON public.events USING btree (((metadata ->> 'github_login'::text))) WHERE (metadata ? 'github_login'::text);


--
-- Name: idx_events_metadata_google_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_metadata_google_contact_id ON public.events USING btree (((metadata ->> 'google_contact_id'::text))) WHERE (metadata ? 'google_contact_id'::text);


--
-- Name: idx_events_metadata_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_metadata_phone ON public.events USING btree (((metadata ->> 'phone'::text))) WHERE (metadata ? 'phone'::text);


--
-- Name: idx_events_metadata_slack_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_metadata_slack_user_id ON public.events USING btree (((metadata ->> 'slack_user_id'::text))) WHERE (metadata ? 'slack_user_id'::text);


--
-- Name: idx_events_metadata_wa_jid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_metadata_wa_jid ON public.events USING btree (((metadata ->> 'wa_jid'::text))) WHERE (metadata ? 'wa_jid'::text);


--
-- Name: idx_events_missing_embedding_backfill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_missing_embedding_backfill ON public.events USING btree (created_at, id) WHERE ((payload_text IS NOT NULL) AND (payload_text <> ''::text));


--
-- Name: idx_events_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_organization_id ON public.events USING btree (organization_id) WHERE (organization_id IS NOT NULL);


--
-- Name: idx_events_origin_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_origin_parent_id ON public.events USING btree (origin_parent_id);


--
-- Name: idx_events_raw_content_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_raw_content_trgm ON public.events USING gin (payload_text public.gin_trgm_ops);


--
-- Name: idx_events_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_run_id ON public.events USING btree (run_id);


--
-- Name: idx_events_semantic_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_semantic_type ON public.events USING btree (semantic_type);


--
-- Name: idx_events_source_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_source_embedding ON public.event_embeddings USING btree (event_id);


--
-- Name: idx_events_superseded_by; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_events_superseded_by ON public.events USING btree (supersedes_event_id) WHERE (supersedes_event_id IS NOT NULL);


--
-- Name: idx_events_thread_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_thread_lookup ON public.events USING btree (origin_parent_id, occurred_at) WHERE (origin_parent_id IS NOT NULL);


--
-- Name: idx_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_type ON public.events USING btree (origin_type) WHERE (origin_type IS NOT NULL);


--
-- Name: idx_feeds_connection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feeds_connection ON public.feeds USING btree (connection_id);


--
-- Name: idx_feeds_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feeds_deleted_at ON public.feeds USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_feeds_entity_ids; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feeds_entity_ids ON public.feeds USING gin (entity_ids);


--
-- Name: idx_feeds_next_run_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feeds_next_run_at ON public.feeds USING btree (next_run_at) WHERE ((status = 'active'::text) AND (deleted_at IS NULL));


--
-- Name: idx_feeds_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feeds_org ON public.feeds USING btree (organization_id);


--
-- Name: idx_feeds_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feeds_status ON public.feeds USING btree (status);


--
-- Name: idx_latest_ec_classifier_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_latest_ec_classifier_id ON public.latest_event_classifications USING btree (classifier_id);


--
-- Name: idx_latest_ec_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_latest_ec_event_id ON public.latest_event_classifications USING btree (event_id);


--
-- Name: idx_latest_ec_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_latest_ec_id ON public.latest_event_classifications USING btree (id);


--
-- Name: idx_latest_ec_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_latest_ec_source ON public.latest_event_classifications USING btree (source);


--
-- Name: idx_latest_ec_values_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_latest_ec_values_gin ON public.latest_event_classifications USING gin ("values");


--
-- Name: idx_notifications_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_listing ON public.notifications USING btree (organization_id, user_id, created_at DESC);


--
-- Name: idx_notifications_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_unread ON public.notifications USING btree (organization_id, user_id, is_read, created_at DESC);


--
-- Name: idx_runs_active_auth_per_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_runs_active_auth_per_profile ON public.runs USING btree (auth_profile_id) WHERE ((run_type = 'auth'::text) AND (auth_profile_id IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'running'::text])));


--
-- Name: idx_runs_active_embed_backfill_per_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_runs_active_embed_backfill_per_org ON public.runs USING btree (organization_id) WHERE ((run_type = 'embed_backfill'::text) AND (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'running'::text])));


--
-- Name: idx_runs_active_sync_per_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_runs_active_sync_per_feed ON public.runs USING btree (feed_id) WHERE ((run_type = 'sync'::text) AND (feed_id IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'running'::text])));


--
-- Name: idx_runs_active_watcher_per_watcher; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_runs_active_watcher_per_watcher ON public.runs USING btree (watcher_id) WHERE ((run_type = 'watcher'::text) AND (watcher_id IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'running'::text])));


--
-- Name: idx_runs_connection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_connection ON public.runs USING btree (connection_id);


--
-- Name: idx_runs_created_by_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_created_by_user ON public.runs USING btree (created_by_user_id) WHERE (created_by_user_id IS NOT NULL);


--
-- Name: idx_runs_dispatched_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_runs_dispatched_message_id ON public.runs USING btree (dispatched_message_id) WHERE (dispatched_message_id IS NOT NULL);


--
-- Name: idx_runs_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_feed ON public.runs USING btree (feed_id);


--
-- Name: idx_runs_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_org ON public.runs USING btree (organization_id);


--
-- Name: idx_runs_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_pending ON public.runs USING btree (status, created_at) WHERE (status = 'pending'::text);


--
-- Name: idx_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_status ON public.runs USING btree (status);


--
-- Name: idx_runs_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_type ON public.runs USING btree (run_type);


--
-- Name: idx_runs_watcher_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_watcher_id ON public.runs USING btree (watcher_id) WHERE (watcher_id IS NOT NULL);


--
-- Name: idx_view_template_versions_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_view_template_versions_resource ON public.view_template_versions USING btree (resource_type, resource_id, organization_id);


--
-- Name: idx_watcher_reactions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watcher_reactions_org ON public.watcher_reactions USING btree (organization_id);


--
-- Name: idx_watcher_reactions_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watcher_reactions_window ON public.watcher_reactions USING btree (watcher_id, window_id);


--
-- Name: idx_watcher_template_versions_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watcher_template_versions_created_by ON public.watcher_versions USING btree (created_by);


--
-- Name: idx_watcher_versions_watcher_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_watcher_versions_watcher_version ON public.watcher_versions USING btree (watcher_id, version);


--
-- Name: idx_watcher_window_events_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watcher_window_events_event ON public.watcher_window_events USING btree (event_id);


--
-- Name: idx_watcher_window_events_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_watcher_window_events_unique ON public.watcher_window_events USING btree (window_id, event_id);


--
-- Name: idx_watcher_window_events_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watcher_window_events_window ON public.watcher_window_events USING btree (window_id);


--
-- Name: idx_watcher_windows_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watcher_windows_parent ON public.watcher_windows USING btree (parent_window_id) WHERE (parent_window_id IS NOT NULL);


--
-- Name: idx_watcher_windows_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watcher_windows_run_id ON public.watcher_windows USING btree (run_id) WHERE (run_id IS NOT NULL);


--
-- Name: idx_watcher_windows_template_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watcher_windows_template_version ON public.watcher_windows USING btree (version_id);


--
-- Name: idx_watcher_windows_unique_period; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_watcher_windows_unique_period ON public.watcher_windows USING btree (watcher_id, window_start, window_end) WHERE (is_rollup = false);


--
-- Name: idx_watcher_windows_watcher; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watcher_windows_watcher ON public.watcher_windows USING btree (watcher_id, granularity, window_start DESC);


--
-- Name: idx_watchers_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchers_agent_id ON public.watchers USING btree (agent_id) WHERE (agent_id IS NOT NULL);


--
-- Name: idx_watchers_connection_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchers_connection_id ON public.watchers USING btree (connection_id) WHERE (connection_id IS NOT NULL);


--
-- Name: idx_watchers_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchers_created_by ON public.watchers USING btree (created_by);


--
-- Name: idx_watchers_entity_ids; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchers_entity_ids ON public.watchers USING gin (entity_ids);


--
-- Name: idx_watchers_next_run_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchers_next_run_at ON public.watchers USING btree (next_run_at) WHERE ((schedule IS NOT NULL) AND (status = 'active'::text));


--
-- Name: idx_watchers_org_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchers_org_group ON public.watchers USING btree (organization_id, watcher_group_id);


--
-- Name: idx_watchers_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_watchers_org_slug ON public.watchers USING btree (organization_id, slug) WHERE (slug IS NOT NULL);


--
-- Name: idx_watchers_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchers_organization_id ON public.watchers USING btree (organization_id) WHERE (organization_id IS NOT NULL);


--
-- Name: idx_watchers_watcher_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchers_watcher_group_id ON public.watchers USING btree (watcher_group_id);


--
-- Name: idx_wwff_watcher_field_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wwff_watcher_field_recent ON public.watcher_window_field_feedback USING btree (watcher_id, field_path, created_at DESC);


--
-- Name: idx_wwff_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wwff_window ON public.watcher_window_field_feedback USING btree (window_id);


--
-- Name: invitation_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitation_email_idx ON public.invitation USING btree (email);


--
-- Name: invitation_organizationId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invitation_organizationId_idx" ON public.invitation USING btree ("organizationId");


--
-- Name: mcp_proxy_sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_proxy_sessions_expires_at_idx ON public.mcp_proxy_sessions USING btree (expires_at);


--
-- Name: mcp_sessions_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_sessions_client_id_idx ON public.mcp_sessions USING btree (client_id);


--
-- Name: mcp_sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_sessions_expires_at_idx ON public.mcp_sessions USING btree (expires_at);


--
-- Name: mcp_sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_sessions_user_id_idx ON public.mcp_sessions USING btree (user_id);


--
-- Name: member_organizationId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "member_organizationId_idx" ON public.member USING btree ("organizationId");


--
-- Name: member_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "member_userId_idx" ON public.member USING btree ("userId");


--
-- Name: namespace_ref_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX namespace_ref_id_idx ON public.namespace USING btree (ref_id);


--
-- Name: namespace_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX namespace_type_idx ON public.namespace USING btree (type);


--
-- Name: oauth_authorization_codes_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_authorization_codes_client_id_idx ON public.oauth_authorization_codes USING btree (client_id);


--
-- Name: oauth_authorization_codes_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_authorization_codes_expires_at_idx ON public.oauth_authorization_codes USING btree (expires_at);


--
-- Name: oauth_clients_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_clients_organization_id_idx ON public.oauth_clients USING btree (organization_id);


--
-- Name: oauth_clients_software_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_clients_software_id_idx ON public.oauth_clients USING btree (software_id);


--
-- Name: oauth_clients_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_clients_user_id_idx ON public.oauth_clients USING btree (user_id);


--
-- Name: oauth_device_codes_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_device_codes_client_id_idx ON public.oauth_device_codes USING btree (client_id);


--
-- Name: oauth_device_codes_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_device_codes_expires_at_idx ON public.oauth_device_codes USING btree (expires_at);


--
-- Name: oauth_device_codes_user_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX oauth_device_codes_user_code_idx ON public.oauth_device_codes USING btree (user_code);


--
-- Name: oauth_states_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_states_expires_at_idx ON public.oauth_states USING btree (expires_at);


--
-- Name: oauth_states_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_states_scope_idx ON public.oauth_states USING btree (scope);


--
-- Name: oauth_tokens_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_tokens_active_idx ON public.oauth_tokens USING btree (user_id, expires_at) WHERE (revoked_at IS NULL);


--
-- Name: oauth_tokens_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_tokens_client_id_idx ON public.oauth_tokens USING btree (client_id);


--
-- Name: oauth_tokens_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_tokens_expires_at_idx ON public.oauth_tokens USING btree (expires_at);


--
-- Name: oauth_tokens_token_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_tokens_token_hash_idx ON public.oauth_tokens USING btree (token_hash);


--
-- Name: oauth_tokens_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_tokens_user_id_idx ON public.oauth_tokens USING btree (user_id);


--
-- Name: personal_access_tokens_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_access_tokens_active_idx ON public.personal_access_tokens USING btree (user_id, expires_at) WHERE (revoked_at IS NULL);


--
-- Name: personal_access_tokens_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_access_tokens_organization_id_idx ON public.personal_access_tokens USING btree (organization_id);


--
-- Name: personal_access_tokens_token_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_access_tokens_token_hash_idx ON public.personal_access_tokens USING btree (token_hash);


--
-- Name: personal_access_tokens_token_prefix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_access_tokens_token_prefix_idx ON public.personal_access_tokens USING btree (token_prefix);


--
-- Name: personal_access_tokens_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_access_tokens_user_id_idx ON public.personal_access_tokens USING btree (user_id);


--
-- Name: rate_limits_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rate_limits_expires_at_idx ON public.rate_limits USING btree (expires_at);


--
-- Name: runs_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_expires_at_idx ON public.runs USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: runs_idempotency_key_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_idempotency_key_uniq ON public.runs USING btree (idempotency_key) WHERE ((idempotency_key IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'running'::text])));


--
-- Name: runs_lobu_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_lobu_claim_idx ON public.runs USING btree (run_type, queue_name, priority DESC, run_at, id) WHERE ((status = 'pending'::text) AND (run_type = ANY (ARRAY['chat_message'::text, 'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text])));


--
-- Name: session_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "session_expiresAt_idx" ON public.session USING btree ("expiresAt");


--
-- Name: session_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_token_idx ON public.session USING btree (token);


--
-- Name: session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");


--
-- Name: user_auth_profiles_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_auth_profiles_agent_id_idx ON public.user_auth_profiles USING btree (agent_id);


--
-- Name: user_username_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_username_unique ON public."user" USING btree (username);


--
-- Name: verification_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "verification_expiresAt_idx" ON public.verification USING btree ("expiresAt");


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: entities check_entity_cycles; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER check_entity_cycles BEFORE INSERT OR UPDATE ON public.entities FOR EACH ROW EXECUTE FUNCTION public.prevent_entity_cycles();


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: agent_channel_bindings agent_channel_bindings_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_channel_bindings
    ADD CONSTRAINT agent_channel_bindings_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_connections agent_connections_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_connections
    ADD CONSTRAINT agent_connections_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_grants agent_grants_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_users agent_users_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_users
    ADD CONSTRAINT agent_users_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agents agents_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: agents agents_template_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_template_agent_id_fkey FOREIGN KEY (template_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: auth_profiles auth_profiles_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_profiles
    ADD CONSTRAINT auth_profiles_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.account(id) ON DELETE SET NULL;


--
-- Name: auth_profiles auth_profiles_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_profiles
    ADD CONSTRAINT auth_profiles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: chat_connections chat_connections_template_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_connections
    ADD CONSTRAINT chat_connections_template_agent_id_fkey FOREIGN KEY (template_agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: connect_tokens connect_tokens_auth_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connect_tokens
    ADD CONSTRAINT connect_tokens_auth_profile_id_fkey FOREIGN KEY (auth_profile_id) REFERENCES public.auth_profiles(id) ON DELETE SET NULL;


--
-- Name: connect_tokens connect_tokens_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connect_tokens
    ADD CONSTRAINT connect_tokens_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.connections(id) ON DELETE CASCADE;


--
-- Name: connections connections_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.account(id) ON DELETE SET NULL;


--
-- Name: connections connections_app_auth_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_app_auth_profile_id_fkey FOREIGN KEY (organization_id, app_auth_profile_id) REFERENCES public.auth_profiles(organization_id, id) ON DELETE SET NULL;


--
-- Name: connections connections_auth_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_auth_profile_id_fkey FOREIGN KEY (organization_id, auth_profile_id) REFERENCES public.auth_profiles(organization_id, id) ON DELETE SET NULL;


--
-- Name: connections connections_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: connections connections_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: connector_definitions connector_definitions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_definitions
    ADD CONSTRAINT connector_definitions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: entities entities_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE RESTRICT;


--
-- Name: entities entities_entity_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_entity_type_id_fkey FOREIGN KEY (entity_type_id) REFERENCES public.entity_types(id);


--
-- Name: entities entities_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: entities entities_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.entities(id) ON DELETE RESTRICT;


--
-- Name: entities entities_view_template_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_view_template_version_fk FOREIGN KEY (current_view_template_version_id) REFERENCES public.view_template_versions(id);


--
-- Name: entity_identities entity_identities_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_identities
    ADD CONSTRAINT entity_identities_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_identities entity_identities_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_identities
    ADD CONSTRAINT entity_identities_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: entity_read_grant entity_read_grant_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_read_grant
    ADD CONSTRAINT entity_read_grant_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_read_grant entity_read_grant_grantee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_read_grant
    ADD CONSTRAINT entity_read_grant_grantee_user_id_fkey FOREIGN KEY (grantee_user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: entity_read_grant entity_read_grant_grantor_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_read_grant
    ADD CONSTRAINT entity_read_grant_grantor_org_id_fkey FOREIGN KEY (grantor_org_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: entity_relationship_type_rules entity_relationship_type_rules_relationship_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationship_type_rules
    ADD CONSTRAINT entity_relationship_type_rules_relationship_type_id_fkey FOREIGN KEY (relationship_type_id) REFERENCES public.entity_relationship_types(id) ON DELETE CASCADE;


--
-- Name: entity_relationship_types entity_relationship_types_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationship_types
    ADD CONSTRAINT entity_relationship_types_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: entity_relationship_types entity_relationship_types_inverse_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationship_types
    ADD CONSTRAINT entity_relationship_types_inverse_type_id_fkey FOREIGN KEY (inverse_type_id) REFERENCES public.entity_relationship_types(id) ON DELETE SET NULL;


--
-- Name: entity_relationship_types entity_relationship_types_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationship_types
    ADD CONSTRAINT entity_relationship_types_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: entity_relationships entity_relationships_from_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_from_entity_id_fkey FOREIGN KEY (from_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_relationship_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_relationship_type_id_fkey FOREIGN KEY (relationship_type_id) REFERENCES public.entity_relationship_types(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_to_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_to_entity_id_fkey FOREIGN KEY (to_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: entity_type_audit entity_type_audit_actor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_type_audit
    ADD CONSTRAINT entity_type_audit_actor_fkey FOREIGN KEY (actor) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: entity_type_audit entity_type_audit_entity_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_type_audit
    ADD CONSTRAINT entity_type_audit_entity_type_id_fkey FOREIGN KEY (entity_type_id) REFERENCES public.entity_types(id) ON DELETE CASCADE;


--
-- Name: entity_types entity_types_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_types
    ADD CONSTRAINT entity_types_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: entity_types entity_types_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_types
    ADD CONSTRAINT entity_types_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: entity_types entity_types_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_types
    ADD CONSTRAINT entity_types_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: entity_types entity_types_view_template_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_types
    ADD CONSTRAINT entity_types_view_template_version_fk FOREIGN KEY (current_view_template_version_id) REFERENCES public.view_template_versions(id);


--
-- Name: event_classifications event_classifications_classifier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifications
    ADD CONSTRAINT event_classifications_classifier_id_fkey FOREIGN KEY (classifier_version_id) REFERENCES public.event_classifier_versions(id);


--
-- Name: event_classifications event_classifications_classifier_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifications
    ADD CONSTRAINT event_classifications_classifier_version_id_fkey FOREIGN KEY (classifier_version_id) REFERENCES public.event_classifier_versions(id) ON DELETE RESTRICT;


--
-- Name: event_classifications event_classifications_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifications
    ADD CONSTRAINT event_classifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: event_classifications event_classifications_insight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifications
    ADD CONSTRAINT event_classifications_insight_id_fkey FOREIGN KEY (watcher_id) REFERENCES public.watchers(id) ON DELETE CASCADE;


--
-- Name: event_classifications event_classifications_window_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifications
    ADD CONSTRAINT event_classifications_window_id_fkey FOREIGN KEY (window_id) REFERENCES public.watcher_windows(id) ON DELETE CASCADE;


--
-- Name: event_classifier_versions event_classifier_versions_classifier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifier_versions
    ADD CONSTRAINT event_classifier_versions_classifier_id_fkey FOREIGN KEY (classifier_id) REFERENCES public.event_classifiers(id) ON DELETE CASCADE;


--
-- Name: event_classifier_versions event_classifier_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifier_versions
    ADD CONSTRAINT event_classifier_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE RESTRICT;


--
-- Name: event_classifiers event_classifiers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifiers
    ADD CONSTRAINT event_classifiers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE RESTRICT;


--
-- Name: event_classifiers event_classifiers_insight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifiers
    ADD CONSTRAINT event_classifiers_insight_id_fkey FOREIGN KEY (watcher_id) REFERENCES public.watchers(id) ON DELETE CASCADE;


--
-- Name: event_classifiers event_classifiers_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifiers
    ADD CONSTRAINT event_classifiers_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: event_embeddings event_embeddings_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_embeddings
    ADD CONSTRAINT event_embeddings_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: events events_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(id) ON DELETE SET NULL;


--
-- Name: events events_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.connections(id) ON DELETE SET NULL;


--
-- Name: events events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: events events_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.feeds(id) ON DELETE SET NULL;


--
-- Name: events events_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: events events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;


--
-- Name: events events_supersedes_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_supersedes_event_id_fkey FOREIGN KEY (supersedes_event_id) REFERENCES public.events(id) ON DELETE SET NULL;


--
-- Name: feeds feeds_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeds
    ADD CONSTRAINT feeds_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.connections(id) ON DELETE CASCADE;


--
-- Name: feeds feeds_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeds
    ADD CONSTRAINT feeds_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: event_classifiers fk_event_classifiers_entity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifiers
    ADD CONSTRAINT fk_event_classifiers_entity FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: event_classifiers fk_event_classifiers_insight; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_classifiers
    ADD CONSTRAINT fk_event_classifiers_insight FOREIGN KEY (watcher_id) REFERENCES public.watchers(id) ON DELETE SET NULL;


--
-- Name: grants grants_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grants
    ADD CONSTRAINT grants_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: watcher_versions insight_template_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_versions
    ADD CONSTRAINT insight_template_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE RESTRICT;


--
-- Name: watcher_window_events insight_window_events_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_window_events
    ADD CONSTRAINT insight_window_events_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: watcher_window_events insight_window_events_window_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_window_events
    ADD CONSTRAINT insight_window_events_window_id_fkey FOREIGN KEY (window_id) REFERENCES public.watcher_windows(id) ON DELETE CASCADE;


--
-- Name: watcher_windows insight_windows_insight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_windows
    ADD CONSTRAINT insight_windows_insight_id_fkey FOREIGN KEY (watcher_id) REFERENCES public.watchers(id) ON DELETE CASCADE;


--
-- Name: watcher_windows insight_windows_parent_window_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_windows
    ADD CONSTRAINT insight_windows_parent_window_id_fkey FOREIGN KEY (parent_window_id) REFERENCES public.watcher_windows(id) ON DELETE CASCADE;


--
-- Name: watchers insights_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchers
    ADD CONSTRAINT insights_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE RESTRICT;


--
-- Name: invitation invitation_inviterId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: invitation invitation_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: mcp_sessions mcp_sessions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_sessions
    ADD CONSTRAINT mcp_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: mcp_sessions mcp_sessions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_sessions
    ADD CONSTRAINT mcp_sessions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: mcp_sessions mcp_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_sessions
    ADD CONSTRAINT mcp_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: member member_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: member member_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauth_authorization_codes oauth_authorization_codes_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: oauth_authorization_codes oauth_authorization_codes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE SET NULL;


--
-- Name: oauth_authorization_codes oauth_authorization_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauth_clients oauth_clients_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: oauth_clients oauth_clients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauth_device_codes oauth_device_codes_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_device_codes
    ADD CONSTRAINT oauth_device_codes_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: oauth_device_codes oauth_device_codes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_device_codes
    ADD CONSTRAINT oauth_device_codes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE SET NULL;


--
-- Name: oauth_device_codes oauth_device_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_device_codes
    ADD CONSTRAINT oauth_device_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauth_tokens oauth_tokens_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: oauth_tokens oauth_tokens_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE SET NULL;


--
-- Name: oauth_tokens oauth_tokens_parent_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_parent_token_id_fkey FOREIGN KEY (parent_token_id) REFERENCES public.oauth_tokens(id) ON DELETE SET NULL;


--
-- Name: oauth_tokens oauth_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: organization_lobu_links organization_lobu_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_lobu_links
    ADD CONSTRAINT organization_lobu_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: organization_lobu_links organization_lobu_links_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_lobu_links
    ADD CONSTRAINT organization_lobu_links_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: personal_access_tokens personal_access_tokens_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE SET NULL;


--
-- Name: personal_access_tokens personal_access_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: runs runs_auth_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_auth_profile_id_fkey FOREIGN KEY (auth_profile_id) REFERENCES public.auth_profiles(id) ON DELETE CASCADE;


--
-- Name: runs runs_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.connections(id) ON DELETE SET NULL;


--
-- Name: runs runs_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: runs runs_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.feeds(id) ON DELETE SET NULL;


--
-- Name: runs runs_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: runs runs_watcher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_watcher_id_fkey FOREIGN KEY (watcher_id) REFERENCES public.watchers(id) ON DELETE SET NULL;


--
-- Name: runs runs_window_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_window_id_fkey FOREIGN KEY (window_id) REFERENCES public.watcher_windows(id) ON DELETE SET NULL;


--
-- Name: session session_activeOrganizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_activeOrganizationId_fkey" FOREIGN KEY ("activeOrganizationId") REFERENCES public.organization(id) ON DELETE SET NULL;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: view_template_active_tabs view_template_active_tabs_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_template_active_tabs
    ADD CONSTRAINT view_template_active_tabs_version_fk FOREIGN KEY (current_version_id) REFERENCES public.view_template_versions(id);


--
-- Name: watcher_reactions watcher_reactions_watcher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_reactions
    ADD CONSTRAINT watcher_reactions_watcher_id_fkey FOREIGN KEY (watcher_id) REFERENCES public.watchers(id) ON DELETE CASCADE;


--
-- Name: watcher_reactions watcher_reactions_window_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_reactions
    ADD CONSTRAINT watcher_reactions_window_id_fkey FOREIGN KEY (window_id) REFERENCES public.watcher_windows(id) ON DELETE CASCADE;


--
-- Name: watcher_versions watcher_versions_watcher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_versions
    ADD CONSTRAINT watcher_versions_watcher_id_fkey FOREIGN KEY (watcher_id) REFERENCES public.watchers(id) ON DELETE CASCADE;


--
-- Name: watcher_window_field_feedback watcher_window_field_feedback_watcher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_window_field_feedback
    ADD CONSTRAINT watcher_window_field_feedback_watcher_id_fkey FOREIGN KEY (watcher_id) REFERENCES public.watchers(id) ON DELETE CASCADE;


--
-- Name: watcher_window_field_feedback watcher_window_field_feedback_window_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_window_field_feedback
    ADD CONSTRAINT watcher_window_field_feedback_window_id_fkey FOREIGN KEY (window_id) REFERENCES public.watcher_windows(id) ON DELETE CASCADE;


--
-- Name: watcher_windows watcher_windows_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_windows
    ADD CONSTRAINT watcher_windows_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;


--
-- Name: watcher_windows watcher_windows_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watcher_windows
    ADD CONSTRAINT watcher_windows_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.watcher_versions(id);


--
-- Name: watchers watchers_current_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchers
    ADD CONSTRAINT watchers_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES public.watcher_versions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;


--
-- Name: watchers watchers_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchers
    ADD CONSTRAINT watchers_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict M2CVBCWaQpZ2IaSZ0tLvIsiZcxaeHAXCvAhTje2jQXnlRxfcYhzgFruwfb40Hgl


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('00000000000000'),
    ('20260328180843'),
    ('20260328182759'),
    ('20260328200000'),
    ('20260329120000'),
    ('20260329210753'),
    ('20260330110000'),
    ('20260330143000'),
    ('20260331120000'),
    ('20260402120000'),
    ('20260405193000'),
    ('20260408120000'),
    ('20260408120001'),
    ('20260409110000'),
    ('20260409130000'),
    ('20260410120000'),
    ('20260413170000'),
    ('20260416120000'),
    ('20260417100000'),
    ('20260418100000'),
    ('20260418110000'),
    ('20260419120000'),
    ('20260420120000'),
    ('20260424030000'),
    ('20260424130000'),
    ('20260425100000'),
    ('20260425120000'),
    ('20260425130000'),
    ('20260426120000'),
    ('20260426130000'),
    ('20260426130001'),
    ('20260427133000'),
    ('20260427140000'),
    ('20260427150000'),
    ('20260427160000'),
    ('20260427170000'),
    ('20260428040000'),
    ('20260428050000'),
    ('20260429010000'),
    ('20260429060000'),
    ('20260429120000'),
    ('20260429120100'),
    ('20260429120200'),
    ('20260429130000'),
    ('20260429140000'),
    ('20260429140100'),
    ('20260429180000'),
    ('20260430151215'),
    ('20260501000000');

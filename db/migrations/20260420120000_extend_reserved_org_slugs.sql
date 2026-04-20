-- migrate:up

-- Extend reserved org slugs to cover infrastructure subdomains.
-- RESERVED_SUBDOMAINS in packages/owletto-backend/src/index.ts already
-- treats www/mcp/static/cdn/... as non-org at the routing layer; this
-- mirrors it at the DB layer so those names can never be claimed.
--
-- `app` is intentionally NOT reserved — `app.lobu.ai` hosts the auth
-- org itself, whose DB row uses slug='app'.

ALTER TABLE public.organization DROP CONSTRAINT IF EXISTS org_slug_not_reserved;

ALTER TABLE public.organization ADD CONSTRAINT org_slug_not_reserved CHECK (
    slug <> ALL (ARRAY[
        'settings',
        'auth',
        'api',
        'templates',
        'help',
        'account',
        'admin',
        'health',
        'login',
        'logout',
        'signup',
        'register',
        'www',
        'mcp',
        'static',
        'assets',
        'cdn',
        'docs',
        'mail'
    ]::text[])
);

-- migrate:down

ALTER TABLE public.organization DROP CONSTRAINT IF EXISTS org_slug_not_reserved;

ALTER TABLE public.organization ADD CONSTRAINT org_slug_not_reserved CHECK (
    slug <> ALL (ARRAY[
        'settings',
        'auth',
        'api',
        'templates',
        'help',
        'account',
        'admin',
        'health',
        'login',
        'logout',
        'signup',
        'register'
    ]::text[])
);

-- migrate:up
-- Simplified PostgreSQL schema for Peerbot with only required tables

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS hstore;

-- Create users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    platform_user_id VARCHAR(100) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(platform, platform_user_id)
);

-- Create user_environ table for environment variables
-- Supports both user-level and channel-level variables with repository isolation
CREATE TABLE user_environ (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    channel_id VARCHAR(100) DEFAULT NULL,  -- NULL = user-level, NOT NULL = channel-level
    repository VARCHAR(255) DEFAULT NULL,   -- Repository context for the env var
    name VARCHAR(255) NOT NULL,
    value TEXT NOT NULL,  -- Always encrypted
    type VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (type IN ('user', 'system', 'channel')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    -- Unique constraint: one env var per user/channel/repo/name combination
    UNIQUE(user_id, channel_id, repository, name)
);

-- Enable Row Level Security on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_environ ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for user-based isolation
CREATE POLICY user_data_isolation ON users
FOR ALL USING (
    platform_user_id = current_setting('app.current_user_id', true)
)
WITH CHECK (
    platform_user_id = current_setting('app.current_user_id', true)
);

CREATE POLICY user_environ_isolation ON user_environ
FOR ALL USING (
    user_id IN (
        SELECT id FROM users
        WHERE platform_user_id = current_setting('app.current_user_id', true)
    )
)
WITH CHECK (
    user_id IN (
        SELECT id FROM users
        WHERE platform_user_id = current_setting('app.current_user_id', true)
    )
);

-- Create indexes for performance
CREATE INDEX idx_users_platform_user ON users(platform, platform_user_id);
CREATE INDEX idx_user_environ_user_id ON user_environ(user_id);
CREATE INDEX idx_user_environ_channel_id ON user_environ(channel_id);
CREATE INDEX idx_user_environ_repository ON user_environ(repository);
CREATE INDEX idx_user_environ_name ON user_environ(name);
CREATE INDEX idx_user_environ_type ON user_environ(type);
CREATE INDEX idx_user_environ_lookup ON user_environ(user_id, channel_id, repository, name);

-- Create function to set user context for RLS
CREATE FUNCTION set_user_context(user_identifier VARCHAR(100))
RETURNS VOID AS $$
BEGIN
    PERFORM set_config('app.current_user_id', user_identifier, true);
END;
$$ LANGUAGE plpgsql;

-- Create the main RLS-aware user creation function for pgboss isolation
CREATE FUNCTION create_isolated_pgboss_user(
    user_identifier VARCHAR(100),
    user_password VARCHAR(255) DEFAULT NULL
) RETURNS VARCHAR(100) AS $$
DECLARE
    role_name VARCHAR(100);
    generated_password VARCHAR(255);
BEGIN
    -- Use the user identifier directly as the role name (lowercase)
    role_name := lower(user_identifier);
    
    -- Generate password if not provided
    IF user_password IS NULL THEN
        generated_password := encode(gen_random_bytes(32), 'base64');
    ELSE
        generated_password := user_password;
    END IF;
    
    -- Create role if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOCREATEDB NOCREATEROLE', 
                      role_name, generated_password);
        
        -- Grant basic schema permissions
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', role_name);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', role_name);
        EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', role_name);
        
        -- Grant pgboss schema permissions
        EXECUTE format('GRANT USAGE ON SCHEMA pgboss TO %I', role_name);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO %I', role_name);
        EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO %I', role_name);
        
        -- Set default privileges for future pgboss objects
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', role_name);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO %I', role_name);
        
        RAISE NOTICE 'Created isolated pgboss user: %', role_name;
    ELSE
        -- Update password for existing user and ensure they have current pgboss permissions
        EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', role_name, generated_password);
        RAISE NOTICE 'Updated password for existing user: %', role_name;
    END IF;
    
    -- Always ensure permissions on all current pgboss tables (handles tables created after initial setup)
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO %I', role_name);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO %I', role_name);
    
    RETURN role_name;
END;
$$ LANGUAGE plpgsql;

-- Create helper function to get environment variables with precedence
-- Priority: Channel+Repo > Channel > User+Repo > User
CREATE FUNCTION get_environ_for_context(
    p_user_id INTEGER,
    p_channel_id VARCHAR(100) DEFAULT NULL,
    p_repository VARCHAR(255) DEFAULT NULL
)
RETURNS TABLE(name VARCHAR(255), value TEXT, type VARCHAR(10), source VARCHAR(20)) AS $$
BEGIN
    RETURN QUERY
    WITH prioritized AS (
        SELECT 
            ue.name, 
            ue.value, 
            ue.type,
            CASE 
                WHEN ue.channel_id IS NOT NULL AND ue.repository IS NOT NULL THEN 'channel_repo'
                WHEN ue.channel_id IS NOT NULL THEN 'channel'
                WHEN ue.repository IS NOT NULL THEN 'user_repo'
                ELSE 'user'
            END as source,
            -- Priority ranking
            CASE
                WHEN ue.channel_id = p_channel_id AND ue.repository = p_repository THEN 1
                WHEN ue.channel_id = p_channel_id AND ue.repository IS NULL THEN 2
                WHEN ue.channel_id IS NULL AND ue.repository = p_repository THEN 3
                WHEN ue.channel_id IS NULL AND ue.repository IS NULL THEN 4
            END as priority
        FROM user_environ ue
        WHERE ue.user_id = p_user_id
          AND (
              (ue.channel_id = p_channel_id AND ue.repository = p_repository) OR
              (ue.channel_id = p_channel_id AND ue.repository IS NULL) OR
              (ue.channel_id IS NULL AND ue.repository = p_repository) OR
              (ue.channel_id IS NULL AND ue.repository IS NULL)
          )
    )
    SELECT DISTINCT ON (name) name, value, type, source
    FROM prioritized
    ORDER BY name, priority;
END;
$$ LANGUAGE plpgsql;

-- Create helper function to set environment variable with context
CREATE FUNCTION set_environ(
    p_user_id INTEGER,
    p_name VARCHAR(255),
    p_value TEXT,
    p_channel_id VARCHAR(100) DEFAULT NULL,
    p_repository VARCHAR(255) DEFAULT NULL,
    p_type VARCHAR(10) DEFAULT 'user'
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO user_environ (user_id, channel_id, repository, name, value, type, updated_at)
    VALUES (p_user_id, p_channel_id, p_repository, p_name, p_value, p_type, NOW())
    ON CONFLICT (user_id, channel_id, repository, name)
    DO UPDATE SET 
        value = EXCLUDED.value,
        type = EXCLUDED.type,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Create function to update job status (for pgboss job management)
CREATE FUNCTION update_job_status(
    p_job_id VARCHAR(100),
    p_status VARCHAR(50),
    p_output JSONB DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    -- This function is a placeholder for pgboss job status updates
    -- In practice, pgboss handles its own job status management
    -- We'll just log the attempt for debugging purposes
    RAISE NOTICE 'Job status update requested: job_id=%, status=%, output=%, error=%', 
                 p_job_id, p_status, p_output, p_error_message;
END;
$$ LANGUAGE plpgsql;

-- migrate:down
-- Not needed for fresh start approach
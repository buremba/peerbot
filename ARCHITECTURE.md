# Peerbot Architecture

## Overview

Peerbot is a Kubernetes-native Slack bot that provides AI-powered coding assistance. It uses a scalable dispatcher-orchestrator-worker pattern with persistent storage for conversation continuity.

## Core Modules

### 🚀 Dispatcher ([`packages/dispatcher/`](packages/dispatcher/))
**Responsibilities**: Slack integration, session management, job queuing
- **Socket listener**: [`src/index.ts`](packages/dispatcher/src/index.ts) - Main Slack app server that connects to Slack via Socket Mode
- **Event Handling**: [`src/slack/slack-event-handlers.ts`](packages/dispatcher/src/slack/slack-event-handlers.ts) - Processes Slack messages/interactions and handles Markdown conversions 
- **Repository Management**: [`src/github/repository-manager.ts`](packages/dispatcher/src/github/repository-manager.ts) - GitHub repository operations

### ⚡ Orchestrator ([`packages/orchestrator/`](packages/orchestrator/))
**Responsibilities**: Queue processing, Kubernetes worker lifecycle, deployment cleanup
- **Main Service**: [`src/index.ts`](packages/orchestrator/src/index.ts) - Queue consumer and service coordinator
- **Deployment Manager**: [`src/k8s/K8sDeploymentManager.ts`](packages/orchestrator/src/k8s/K8sDeploymentManager.ts) and [`src/docker/DockerDeploymentManager.ts`](packages/orchestrator/src/docker/DockerDeploymentManager.ts)
- **Queue Consumer**: [`src/task-queue-consumer.ts`](packages/orchestrator/src/task-queue-consumer.ts) - PostgreSQL/pgboss job processing

### 🔧 Worker ([`packages/worker/`](packages/worker/))
**Responsibilities**: Claude CLI execution, GitHub integration, progress streaming, MCP process management
- **Claude Integration**: [`src/claude-worker.ts`](packages/worker/src/claude-worker.ts) - Claude CLI execution and streaming
- **Queue Integration**: [`src/task-queue-integration.ts`](packages/worker/src/task-queue-integration.ts) - Job processing and status updates
- **MCP Process Server**: [`mcp/process-manager-server.ts`](packages/worker/mcp/process-manager-server.ts) - MCP-based process lifecycle management

## Queue System

### Database Structure
- **Instance**: Single PostgreSQL StatefulSet (8Gi storage) - [Config](charts/peerbot/templates/postgresql-statefulset.yaml)
- **Queue Library**: pgboss for reliable job queuing
- **RLS**: Row Level Security to prevent cross-deployment access with separate user credentials in Postgresql - [Schema](db/migrations/001_initial_schema.sql)

### Queues
1. **`thread_response`**: User messages in Slack threads/channels
2. **`direct_message`**: Direct messages to the bot
3. For each worker deployment **`thread_message_{deploymentId}`**: Each conversation thread gets its own isolated queue, combined with RLS policies to prevent cross-thread access

## User Message Flow

```mermaid
sequenceDiagram
    participant User
    participant Slack
    participant Dispatcher
    participant PostgreSQL
    participant Orchestrator  
    participant Worker
    participant GitHub
    participant Claude

    User->>Slack: Send message "@bot help with code"
    Slack->>Dispatcher: webhook event
    Dispatcher->>Slack: Add 👀 reaction
    Dispatcher->>PostgreSQL: Queue job (thread_response)
    
    PostgreSQL->>Orchestrator: Job available
    Orchestrator->>Orchestrator: Create K8s deployment
    Orchestrator->>Worker: Start worker pod
    
    Worker->>Slack: Replace 👀 with ⚙️
    Worker->>GitHub: Clone/pull repository  
    Worker->>Claude: Execute with --resume
    Claude-->>Slack: Stream progress updates
    Claude->>GitHub: Commit changes
    Worker->>Slack: Replace ⚙️ with ✅
    
    Note over Orchestrator: Auto-scale deployment to 0 after 60min idle
```

## Architecture Diagram

```mermaid
graph TB
    subgraph "Slack Workspace"
        User --> SlackUI[Slack UI]
    end
    
    subgraph "Kubernetes Cluster"
        SlackUI --> Dispatcher[Dispatcher<br/>Long-lived Pod]
        
        subgraph "Data Layer"
            PostgreSQL[(PostgreSQL<br/>Queue Storage)]
            PVC[Persistent Volume<br/>User Workspaces]
        end
        
        Dispatcher --> PostgreSQL
        PostgreSQL --> Orchestrator[Orchestrator<br/>Long-lived Pod]
        
        subgraph "Worker Pods"
            Orchestrator --> Worker1[Worker Pod 1<br/>60min timeout]
            Orchestrator --> Worker2[Worker Pod N<br/>60min timeout]
        end
        
        Worker1 --> PVC
        Worker2 --> PVC
    end
    
    subgraph "External APIs"
        Worker1 --> GitHub[GitHub API]
        Worker1 --> ClaudeAPI[Claude API]
        Worker2 --> GitHub
        Worker2 --> ClaudeAPI
    end
    
    style Dispatcher fill:#e1f5fe
    style Orchestrator fill:#f3e5f5  
    style Worker1 fill:#e8f5e8
    style Worker2 fill:#e8f5e8
```

## Session Persistence

### How Conversations Continue
1. **Persistent Volume**: Single 10GB PVC shared across all workers
2. **User Isolation**: Each user gets `/workspace/user-{username}/` directory  
3. **Claude Sessions**: Global session data stored in `/workspace/.claude-sessions/` and symlinked to `~/.claude`
4. **Auto-Resume**: Workers use `claude --resume <session-id>` to continue conversations
5. **No Data Loss**: Both project data and Claude sessions persist across worker pod restarts

### Background Process Management
Workers include a background process management MCP server.

### Directory Structure
```
/workspace/                     # PVC mount point (K8s) or local workspaces dir (Docker)
├── .claude-sessions/          # Claude CLI global session data (symlinked from ~/.claude)
│   ├── projects/              # Project contexts across all threads
│   ├── sessions/              # Conversation history for all sessions
│   └── settings.mcp.json      # MCP server configuration
├── U095ZLHKP98/               # Per-userId directory
│   ├── 1756492073.980799/     # Per-thread workspace (threadId/timestamp)
│   │   ├── .git/              # Cloned repository
│   │   └── [project files]    # User's code from repository
│   └── 1756491379.629309/     # Another thread workspace
│       ├── .git/
│       └── [project files]
└── U09513HH1N1/               # Another user's workspace
    ├── 1756479858.121779/     # Thread-specific workspace
    │   ├── .git/
    │   └── [project files]
    └── 1756491388.020389/     # Another thread workspace
        ├── .git/
        └── [project files]
```

## Deployment Management

### Worker Lifecycle
- **Creation**: Orchestrator creates Kubernetes deployment per conversation thread
- **Scaling**: Deployments start with 1 replica, scale to 0 after 60 minutes idle
- **Cleanup**: Idle worker cleanup runs every minute, removes deployments idle >60min
- **Persistence**: User data remains in PVC even after pod deletion - [Storage Config](charts/peerbot/templates/worker-pvc.yaml)

**Container Images:**
- **Dispatcher**: [`Dockerfile.dispatcher`](Dockerfile.dispatcher)
- **Orchestrator**: [`Dockerfile.orchestrator`](Dockerfile.orchestrator) 
- **Worker**: [`Dockerfile.worker`](Dockerfile.worker)

### Idle Worker Cleanup Process

The orchestrator automatically cleans up idle worker deployments to prevent resource accumulation:

1. **Cleanup Schedule**: Runs every minute via `setInterval`
2. **Idle Detection**: SQL query identifies deployments with no activity for >60 minutes:
   ```sql
   SELECT deployment_id, user_id, last_activity, 
          EXTRACT(EPOCH FROM (NOW() - last_activity))/60 as minutes_idle,
          COUNT(*) as message_count
   FROM pgboss.job 
   WHERE name = 'thread_response' 
     AND last_activity < NOW() - INTERVAL '60 minutes'
   GROUP BY deployment_id, user_id
   ```
3. **Resource Cleanup**: For each idle deployment, removes:
   - Kubernetes Deployment: `peerbot-worker-{deploymentId}`
   - PersistentVolumeClaim: `peerbot-workspace-{deploymentId}` (if exists)
   - Kubernetes Secret: `peerbot-user-secret-{username}`
4. **Logging**: Detailed logs show which deployments were cleaned up and why

### PostgreSQL User Management & RLS

Each worker gets isolated database access through dedicated PostgreSQL users:

#### User Creation Process
1. **Username Generation**: `slack_{workspaceId}_{userId}` (lowercase)
2. **Password**: 32-character random string (URL-safe characters)
3. **Database User**: Created with pgboss schema permissions:
   ```sql
   CREATE USER "slack_workspace_user123" WITH PASSWORD 'randompassword';
   GRANT USAGE ON SCHEMA pgboss TO "slack_workspace_user123";
   GRANT ALL ON ALL TABLES IN SCHEMA pgboss TO "slack_workspace_user123";
   ```
4. **Kubernetes Secret**: Credentials stored in `peerbot-user-secret-{username}`

#### Row Level Security (RLS)
Database queries execute with user context for access control:
```sql
-- Set user context before queries
SELECT set_config('app.current_user_id', $1, true);
-- RLS policies can now filter based on current_setting('app.current_user_id')
```

This ensures workers can only access their own thread messages and user data.

## Status Indicators

| Emoji | Status | Description |
|-------|--------|-------------|
| ⚙️ | Processing | The deployment is active, processing user's request or running background processes |
| ✅ | Complete | Task completed successfully |
| ❌ | Failed | Error during execution |
| ⏳ | Timeout | Job exceeded time limit |

## Rate Limiting & Security

- **Rate Limits**: 5 jobs per user per 15 minutes
- **Pod Security**: Non-root containers, read-only filesystem except `/workspace`
- **Network**: Workers access only GitHub and Claude API - [Network Policy](charts/peerbot/templates/network-policy.yaml)
- **Secrets**: Kubernetes secrets for API tokens, mounted as volumes - [Secret Template](charts/peerbot/templates/secrets.yaml)

## Development & Testing

- **Local Setup**: [make setup](Makefile) - Interactive configuration wizard
- **Development Mode**: [`make dev`](Makefile) - Hot reload with Docker
- **QA Testing**: [`slack-qa-bot.js`](slack-qa-bot.js) - Automated bot testing tool
- **Kubernetes Deployment**: [`make k8s-install`](Makefile) - Deploy to K8s cluster
---
title: Kubernetes
description: How Lobu works in Kubernetes mode.
sidebar:
  order: 2
---

Kubernetes mode is designed for production-grade, multi-tenant deployments.

## How It Works

1. Gateway runs as a cluster service and orchestrates workers.
2. For active conversations, gateway creates worker deployments/pods.
3. Workers run OpenClaw runtime and connect back to gateway for job delivery.
4. Worker storage is backed by PVCs mounted at `/workspace` for session continuity.

## Isolation and Security Controls

Typical controls in Kubernetes mode include:

- Pod-level isolation for workers
- NetworkPolicies to restrict direct egress
- Gateway-mediated outbound traffic and MCP calls
- RBAC for least-privilege gateway orchestration
- Optional hardened runtimes such as gVisor/Kata where available

## Persistence Model

- Worker session data is stored under `/workspace`
- Per-deployment PVCs preserve state across scale-to-zero/resume cycles
- PVCs are cleaned up when deployments are removed after inactivity

## When to Use Kubernetes Mode

Use Kubernetes mode when you need:

- Stronger tenant isolation
- Cluster scheduling and autoscaling
- Production operations with Helm-based deployment

## Deployment

The Helm chart is published as an OCI artifact to GitHub Container Registry:

```bash
helm install lobu oci://ghcr.io/lobu-ai/charts/lobu
```

The chart uses `ghcr.io/lobu-ai/lobu-gateway` and `ghcr.io/lobu-ai/lobu-worker-base` images. Configure secrets via Sealed Secrets or your preferred secrets manager.

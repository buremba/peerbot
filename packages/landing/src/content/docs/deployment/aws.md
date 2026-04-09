---
title: AWS
description: Run Lobu on AWS with Bedrock, EKS, and S3 Files.
sidebar:
  order: 3
---

Lobu runs natively on AWS infrastructure. Use Bedrock for Claude models via IAM, EKS for production orchestration, and S3 Files for persistent worker storage — all without leaving your AWS account.

## Amazon Bedrock

Bedrock lets you call Claude models through your AWS account using IAM credentials instead of Anthropic API keys. The gateway proxies all model requests, so workers never see AWS credentials.

### How it works

1. Gateway detects AWS credentials from the environment (IAM role, env vars, OIDC, or container credentials).
2. Workers send standard Anthropic API requests to the gateway proxy.
3. Gateway converts requests to Bedrock format, calls Bedrock with IAM auth, and streams responses back in Anthropic format.
4. Workers use the standard Anthropic SDK — no Bedrock-specific code needed.

```
Worker (Anthropic SDK) → Gateway Proxy → Amazon Bedrock → Claude
```

### Supported models

All Claude models available on Bedrock are supported. The gateway automatically selects the correct region-prefixed model ID based on your `AWS_REGION`. See [Bedrock supported models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html) for the full list and regional availability.

### Configuration

Set AWS credentials on the gateway host. No per-user API keys needed.

**IAM Role (recommended for EKS)**:
Use [IAM Roles for Service Accounts (IRSA)](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html) or [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) to attach a role to the gateway pod. No env vars required.

**Environment variables** (any combination):

| Variable | Description |
|----------|-------------|
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | Static IAM credentials |
| `AWS_PROFILE` | Named profile from `~/.aws/credentials` |
| `AWS_WEB_IDENTITY_TOKEN_FILE` | OIDC federation (used by IRSA) |
| `BEDROCK_ENABLED` | Set to `true` to force-enable Bedrock provider |

The Bedrock provider auto-enables when any AWS credential is detected. Once enabled, it appears as a provider option in the agent settings UI.

### Required IAM permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.*"
    }
  ]
}
```

### Embedded mode

When embedding Lobu in a Node.js app running on AWS (Lambda, ECS, App Runner), Bedrock works the same way — the runtime's IAM role provides credentials automatically:

```typescript
import { Lobu } from "@lobu/gateway";

const lobu = new Lobu({
  redis: process.env.REDIS_URL!,
  agents: [
    {
      id: "support",
      name: "Support Agent",
      // Use bedrock provider — credentials come from IAM role
      providers: [{ id: "bedrock" }],
    },
  ],
});

await lobu.start();
```

## Amazon EKS

EKS is the recommended way to run Lobu in production on AWS. The Helm chart works with EKS out of the box.

### Deploy to EKS

```bash
# Add the Lobu Helm repo and install
helm install lobu ./charts/lobu \
  --set gateway.image.tag=latest \
  --set redis.enabled=true
```

### EKS-specific considerations

**Networking**: Workers run on an isolated internal network. The gateway sits on both public and internal networks, acting as the single egress point. On EKS, this maps to Kubernetes NetworkPolicies.

**Storage**: Worker PVCs use the default StorageClass. On EKS, this is typically `gp3` EBS volumes via the [EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html). For S3-backed storage, see the next section.

**Autoscaling**: Workers scale to zero when idle and resume on demand. Use [Karpenter](https://karpenter.sh/) or Cluster Autoscaler to scale the underlying node pool.

**IAM**: Use IRSA or Pod Identity to grant the gateway pod Bedrock permissions and the ability to manage worker deployments.

## S3 Files for worker storage

[Amazon S3 Files](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-file-systems-creating.html) creates NFS-compatible file systems backed by S3 buckets. This is useful for worker storage on EKS — agents get persistent `/workspace` directories that survive pod restarts, backed by durable S3 storage.

### Why S3 Files

By default, workers use EBS-backed PVCs. S3 Files offers an alternative with different tradeoffs:

| | EBS PVC (default) | S3 Files |
|---|---|---|
| **Durability** | Single-AZ | S3 durability (11 nines) |
| **Sharing** | One pod at a time | Multiple pods can mount |
| **Cost** | $0.08/GB-month (gp3) | S3 pricing + file system fee |
| **Performance** | Block-level, fast | File-level, good for sequential I/O |
| **Use case** | Single-agent workspaces | Shared data, cross-AZ resilience |

### Setup

1. **Create a file system** from an S3 bucket:

```bash
aws s3files create-file-system \
  --region us-east-1 \
  --bucket arn:aws:s3:::my-lobu-workspaces \
  --role-arn arn:aws:iam::123456789012:role/S3FilesRole
```

2. **Mount in EKS** using the [Mountpoint for Amazon S3 CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/s3-csi.html) or NFS mount targets that S3 Files creates in your VPC.

3. **Configure worker PVCs** to use the S3-backed StorageClass in your Helm values.

### Embedded mode

In embedded mode, each worker writes to a local `workspaces/{agentId}` directory. By default this is ephemeral — if the container restarts, workspace data is lost. To make it persistent on AWS, mount S3 Files or EFS at the `workspaces/` path.

**ECS (Fargate or EC2)**:

Add an EFS or S3 Files mount point to your task definition:

```json
{
  "containerDefinitions": [{
    "mountPoints": [{
      "sourceVolume": "agent-workspaces",
      "containerPath": "/app/workspaces"
    }]
  }],
  "volumes": [{
    "name": "agent-workspaces",
    "efsVolumeConfiguration": {
      "fileSystemId": "fs-0123456789abcdef0",
      "rootDirectory": "/workspaces"
    }
  }]
}
```

For S3 Files, use the NFS mount targets it creates in your VPC — ECS treats them the same as EFS mount points.

**Lambda**:

Mount an EFS or S3 Files file system via [Lambda file system configuration](https://docs.aws.amazon.com/lambda/latest/dg/configuration-filesystem.html). Set the local mount path to `/mnt/workspaces` and configure the `workspaces` directory accordingly.

**App Runner**:

App Runner does not support persistent file system mounts. Use ECS if you need durable agent workspaces.

# Deployment Guide

## Overview

This application is automatically deployed to GKE using GitHub Actions when changes are pushed to the `main` branch.

## Architecture

- **Platform**: Google Kubernetes Engine (GKE) 
- **Mode**: HTTP mode with Slack Events API
- **Scaling**: KEDA for scale-to-zero capability
- **Workers**: Run on spot instances for cost optimization

## Cost Optimizations

The deployment includes several cost-saving measures:

1. **Scale-to-Zero**: Dispatcher scales to 0 pods when idle (via KEDA)
2. **Spot Instances**: Workers run on preemptible nodes (60-80% cheaper)
3. **Resource Optimization**: Reduced CPU/memory requests by 50%
4. **Storage Lifecycle**: Automatic tiering to cheaper storage classes

## Deployment Process

### Automatic Deployment (CI/CD)

1. Push changes to `main` branch
2. GitHub Actions will:
   - Build Docker images
   - Push to Google Container Registry
   - Install KEDA (if needed)
   - Deploy using Helm
   - Apply GCS lifecycle policies

### Manual Deployment

```bash
# Set up credentials
export PROJECT_ID=spile-461023
gcloud auth login
gcloud config set project $PROJECT_ID
gcloud container clusters get-credentials spile-cluster --zone us-central1

# Deploy
helm upgrade --install peerbot charts/peerbot \
  --namespace peerbot \
  --create-namespace \
  --values charts/peerbot/values-prod-http-mode.yaml
```

## Configuration Files

- `charts/peerbot/values.yaml` - Base configuration
- `charts/peerbot/values-prod-http-mode.yaml` - Production HTTP mode settings
- `gcs-lifecycle-policy.json` - Storage lifecycle rules
- `.github/workflows/deploy.yml` - CI/CD pipeline

## Monitoring

```bash
# Check pod status
kubectl get pods -n peerbot

# Check KEDA scaling
kubectl get scaledobject -n peerbot

# View logs
kubectl logs -n peerbot -l app.kubernetes.io/name=peerbot

# Check resource usage
kubectl top pods -n peerbot
```

## Rollback

```bash
# List releases
helm list -n peerbot

# Rollback to previous version
helm rollback peerbot -n peerbot
```

## Secrets Management

Secrets are stored in GitHub repository secrets:
- `GCP_CREDENTIALS` - Service account for GKE deployment
- Slack tokens are configured in the values file (should be moved to secrets)

## Cost Monitoring

Expected monthly costs with optimizations:
- **Compute**: ~$10-20 (with scale-to-zero)
- **Storage**: ~$3-5
- **Total**: ~$16-30/month (80%+ reduction from baseline)
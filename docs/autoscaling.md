# Peerbot Autoscaling Configuration

## Overview

Peerbot supports automatic scaling based on resource utilization to handle varying workloads efficiently.

## Current Configuration (Socket Mode)

The default production configuration uses Slack Socket Mode with the following autoscaling settings:

- **Min Replicas**: 1 (maintains persistent WebSocket connection)
- **Max Replicas**: 5
- **Target CPU**: 40%
- **Target Memory**: 60%
- **Scale Down Stabilization**: 5 minutes

### Why Min Replicas = 1?

Socket Mode requires a persistent WebSocket connection to Slack. If scaled to zero, the bot would:
1. Miss incoming messages while scaled down
2. Need to re-establish the connection when scaling up
3. Potentially lose messages during the reconnection period

## True Scale-to-Zero Option (HTTP Mode)

For true scale-to-zero capability, use HTTP mode with Slack Events API:

```bash
helm upgrade peerbot charts/peerbot \
  --namespace peerbot \
  --values charts/peerbot/values-prod-http-mode.yaml
```

### HTTP Mode Requirements

1. **Public Endpoint**: Requires an ingress with TLS
2. **Slack App Configuration**: 
   - Configure Event Subscriptions URL in Slack App settings
   - Point to: `https://your-domain.com/slack/events`
3. **Benefits**:
   - True scale to zero (no cost when idle)
   - Scales based on incoming webhook requests
   - No persistent connections required

## Monitoring Autoscaling

### Check HPA Status
```bash
kubectl get hpa -n peerbot -w
```

### View Scaling Events
```bash
kubectl describe hpa peerbot-dispatcher -n peerbot
```

### Monitor Pod Count
```bash
kubectl get pods -n peerbot -l app.kubernetes.io/component=dispatcher -w
```

## Advanced Scaling with KEDA

For more sophisticated scaling based on custom metrics (e.g., Slack message queue depth):

1. Install KEDA in your cluster
2. Enable KEDA in values:
   ```yaml
   keda:
     enabled: true
     idleReplicaCount: 0
   ```

## Cost Optimization

### Socket Mode (Current)
- Minimum cost: 1 pod with 500m CPU, 1Gi memory
- Scales up automatically under load
- Suitable for consistent usage patterns

### HTTP Mode (Scale-to-Zero)
- Zero cost when idle
- Pay only for actual usage
- Best for sporadic usage patterns
- Requires external ingress/load balancer

## Troubleshooting

### HPA Shows "Unknown" Targets
- Wait 1-2 minutes for metrics to populate
- Ensure metrics-server is running
- Check pod resource requests are set

### Pods Not Scaling Up
- Check HPA events: `kubectl describe hpa peerbot-dispatcher -n peerbot`
- Verify resource limits aren't preventing new pods
- Check cluster autoscaler if using node autoscaling

### Pods Not Scaling Down
- Default stabilization window is 5 minutes
- Check if load is truly below thresholds
- Verify no disruption budget preventing scale down
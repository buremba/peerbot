#!/bin/bash

echo "📊 Monitoring Token Rotation in Production"
echo "=========================================="
echo ""
echo "Current deployment status:"
kubectl get deployment peerbot-dispatcher -n peerbot -o wide
echo ""
echo "Current pod:"
POD=$(kubectl get pods -n peerbot -l app=peerbot-dispatcher -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD"
echo ""
echo "Token rotation status:"
kubectl logs $POD -n peerbot | grep -E "(token|Token|refresh|Refresh|rotation|Scheduling)"
echo ""
echo "To monitor live token refresh events:"
echo "kubectl logs -f $POD -n peerbot | grep -E '(refresh|token|Token|Refresh)'"
echo ""
echo "Next token refresh will occur in approximately 10.5 hours from pod start time"
echo ""
echo "LoadBalancer URL: https://peerbot.peercloud.ai"
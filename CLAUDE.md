# CLAUDE.md

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.

## Infrastructure

### Static IP Management (CRITICAL FOR PRODUCTION)
**IMPORTANT**: The production environment uses a reserved static IP that MUST NOT change. Follow these rules:

1. **NEVER delete or recreate the following resources without explicit user approval:**
   - The GKE Ingress (`peerbot`)
   - The static IP reservation (`peerbot-ip`)
   - The managed certificate (`peerbot-cert`)

2. **Static IP Details:**
   - Resource Name: `peerbot-ip`
   - Type: Global static IP (required for GKE Ingress)
   - Current IP: 34.149.102.45
   - DNS: slack.peerbot.ai

3. **To check the static IP:**
   ```bash
   gcloud compute addresses describe peerbot-ip --global --format="value(address)"
   ```

4. **If you need to update the ingress, use `kubectl apply` or `kubectl patch`, NEVER use `kubectl delete` followed by `kubectl create`**

5. **Before making ANY infrastructure changes:**
   - Check if it will affect the static IP
   - Warn the user if the change might cause IP rotation
   - Get explicit approval for production changes

### LoadBalancer Service (Legacy)
- The LoadBalancer service IP may change when the following events occur but never do them before asking the user:
    1. The LoadBalancer service is recreated
    2. GKE reassigns the IP due to maintenance
    3. The service type is changed

To get the current LoadBalancer IP:
```bash
kubectl get svc peerbot-loadbalancer -n peerbot -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

### DNS Updates
- Always update the Cloudflare DNS A record when any IP changes
- Use flarectl with the .env file:
  ```bash
  source .env
  export CF_API_KEY CF_API_EMAIL
  flarectl dns update --zone peerbot.ai --id <record-id> --content <new-ip> --proxy=false
  ```
- IMPORTANT: Always disable Cloudflare proxy (--proxy=false) for Kubernetes ingress

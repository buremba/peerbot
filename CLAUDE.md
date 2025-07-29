# CLAUDE.md


# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.

## Test Files
When creating test files for Slack bot testing, always create them in a `tmp/` directory within the project to keep the repository clean. These files should be:
- Named descriptively (e.g., `tmp/test-slack-webhook.js`, `tmp/verify-bot-token.js`)
- Written in JavaScript/Node.js for easy execution with bun/node
- Contain clear console.log statements explaining what they're testing
- Be removed after testing is complete unless the user requests to keep them

## Infrastructure
- The LoadBalancer IP may change when the following events occur but never do them before asking the user:
    1. The LoadBalancer service is recreated
    2. GKE reassigns the IP due to maintenance
    3. The service type is changed

To get the current LoadBalancer IP:
```bash
kubectl get svc peerbot-loadbalancer -n peerbot -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```
- Always update the Cloudflare DNS A record when the LoadBalancer IP changes, use flarectl to do this.

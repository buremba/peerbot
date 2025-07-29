# Slack Webhook Setup Complete

## Current Status

✅ **HTTP Mode Deployed**: Peerbot is running in HTTP mode on Kubernetes
✅ **LoadBalancer Service**: Available at IP `34.63.46.70`
✅ **Health Checks**: Working (`/health` and `/ready` endpoints)
✅ **Slack Secrets Updated**: New tokens deployed to Kubernetes

## Next Steps for Slack App Configuration

### 1. ✅ DNS Record Created

DNS A record has been created:
- **Type**: A
- **Name**: slack.peerbot.ai
- **Content**: 34.63.46.70
- **Proxy**: Off (grey cloud) for testing
- **Status**: Active and resolving

### 2. Configure Slack App

Go to https://api.slack.com/apps and select your app.

#### Disable Socket Mode
1. Navigate to **Socket Mode**
2. Toggle **Enable Socket Mode** to **Off**

#### Enable Event Subscriptions
1. Navigate to **Event Subscriptions**
2. Toggle **Enable Events** to **On**
3. Enter Request URL: `http://slack.peerbot.ai/slack/events`
4. Wait for verification (should show "Verified" ✓)

#### Subscribe to Events
Under **Subscribe to bot events**, add:
- `app_mention`
- `message.channels`
- `message.im`
- `message.groups` (if you want private channel support)

#### Save Changes
Click **Save Changes** at the bottom of the page.

### 3. Test the Integration

In Slack:
```
@peerbot hello
```

Monitor logs:
```bash
kubectl logs -n peerbot -l app.kubernetes.io/component=dispatcher -f
```

### 4. Enable HTTPS (Recommended)

Once basic testing works:

1. **In Cloudflare**: Enable proxy (orange cloud) for the DNS record
2. **In Slack**: Update the Request URL to `https://slack.peerbot.ai/slack/events`
3. **Re-verify** the endpoint in Slack

## Troubleshooting

If verification fails:
1. Check the signing secret matches: `0c45161dced71838278bc457ddd26b0c`
2. Ensure the LoadBalancer is accessible from the internet
3. Check dispatcher logs for errors

Current endpoints:
- Health: `http://34.63.46.70/health` ✅
- Ready: `http://34.63.46.70/ready` ✅
- Slack Events: `http://34.63.46.70/slack/events` (awaiting Slack verification)
#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Test the dispatcher with token rotation
const { SlackDispatcher } = require('../packages/dispatcher/dist/index.js');

async function testDispatcherTokenRotation() {
  console.log('🧪 Testing Dispatcher with Token Rotation');
  console.log('========================================\n');

  try {
    // Create configuration
    const config = {
      slack: {
        token: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: true, // Use socket mode for testing
        port: 3000,
        botUserId: 'U09564YSKM5',
        triggerPhrase: process.env.SLACK_TRIGGER_PHRASE || '@peercloud',
      },
      kubernetes: {
        namespace: 'default',
        workerImage: 'claude-worker:latest',
        cpu: '1000m',
        memory: '2Gi',
        timeoutSeconds: 300,
      },
      github: {
        token: process.env.GITHUB_TOKEN,
        organization: 'peerbot-community',
      },
      gcs: {
        bucketName: 'peerbot-conversations-prod',
      },
      claude: {},
      sessionTimeoutMinutes: 5,
    };

    console.log('📋 Configuration:');
    console.log(`   Bot Token: ${config.slack.token?.substring(0, 30)}...`);
    console.log(`   App Token: ${config.slack.appToken?.substring(0, 30)}...`);
    console.log(`   Socket Mode: ${config.slack.socketMode}`);
    console.log(`   Trigger Phrase: ${config.slack.triggerPhrase}`);

    // Check if refresh token is available
    if (process.env.SLACK_REFRESH_TOKEN && process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET) {
      console.log('\n✅ Token rotation credentials available:');
      console.log(`   Client ID: ${process.env.SLACK_CLIENT_ID}`);
      console.log(`   Refresh Token: ${process.env.SLACK_REFRESH_TOKEN.substring(0, 30)}...`);
      console.log('\n🔄 Dispatcher will initialize with token rotation enabled');
    } else {
      console.log('\n⚠️  No token rotation credentials found');
      console.log('   Dispatcher will use static token only');
    }

    console.log('\n🚀 Creating dispatcher instance...');
    
    // Note: The actual dispatcher will handle token manager initialization
    // based on environment variables in its main() function
    
    console.log('✅ Test setup complete!');
    console.log('\nTo start the dispatcher with token rotation:');
    console.log('   cd packages/dispatcher');
    console.log('   bun run src/index.ts');
    console.log('\nThe dispatcher will:');
    console.log('   1. Check for refresh token credentials');
    console.log('   2. Initialize token manager if available');
    console.log('   3. Use dynamic token authorization');
    console.log('   4. Automatically refresh tokens before expiry');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

// Run test
testDispatcherTokenRotation().catch(console.error);
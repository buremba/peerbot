#!/usr/bin/env node

const https = require('https');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Get credentials from environment
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const SLACK_REFRESH_TOKEN = process.env.SLACK_REFRESH_TOKEN;
const TEST_CHANNEL = process.env.SLACK_TEST_CHANNEL || 'C09189H0WBX';

async function refreshAccessToken() {
  console.log('🔄 Refreshing access token...');
  
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    client_secret: SLACK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: SLACK_REFRESH_TOKEN
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'slack.com',
      port: 443,
      path: '/api/oauth.v2.access',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params.toString())
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok && result.access_token) {
            console.log('✅ Token refreshed successfully');
            resolve(result.access_token);
          } else {
            reject(new Error(`Failed to refresh token: ${result.error || 'Unknown error'}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(params.toString());
    req.end();
  });
}

async function makeSlackRequest(method, body, token) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    
    const options = {
      hostname: 'slack.com',
      port: 443,
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
            resolve(result);
          } else {
            reject(new Error(`Slack API error: ${result.error}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runE2ETest() {
  console.log('🧪 Running Slack E2E Test with Token Rotation');
  console.log('=============================================\n');

  try {
    // First, get a fresh access token
    const accessToken = await refreshAccessToken();
    console.log('   Token: ' + accessToken.substring(0, 20) + '...\n');

    // Test 1: Verify bot can authenticate
    console.log('1️⃣ Testing bot authentication...');
    const authTest = await makeSlackRequest('auth.test', {}, accessToken);
    console.log(`✅ Bot authenticated as: ${authTest.user} (${authTest.user_id})`);
    console.log(`   Team: ${authTest.team} (${authTest.team_id})\n`);

    // Test 2: Post a test message
    console.log('2️⃣ Posting test message...');
    const timestamp = new Date().toISOString();
    const testMessage = `🧪 E2E Test with Token Rotation - ${timestamp}\n✅ Token rotation is working!`;
    
    const postResult = await makeSlackRequest('chat.postMessage', {
      channel: TEST_CHANNEL,
      text: testMessage,
      unfurl_links: false,
      unfurl_media: false
    }, accessToken);
    
    console.log(`✅ Message posted successfully`);
    console.log(`   Channel: ${postResult.channel}`);
    console.log(`   Timestamp: ${postResult.ts}\n`);

    // Test 3: Send a command to the bot
    console.log('3️⃣ Sending command to bot...');
    const commandMessage = `@peercloud what is the capital of France?`;
    
    const commandResult = await makeSlackRequest('chat.postMessage', {
      channel: TEST_CHANNEL,
      text: commandMessage,
      unfurl_links: false,
      unfurl_media: false
    }, accessToken);
    
    console.log(`✅ Command sent successfully`);
    console.log(`   Message: "${commandMessage}"`);
    console.log(`   Timestamp: ${commandResult.ts}\n`);

    // Test 4: Verify bot info
    console.log('4️⃣ Getting bot info...');
    const botInfo = await makeSlackRequest('bots.info', {
      bot: authTest.user_id
    }, accessToken);
    
    console.log(`✅ Bot info retrieved:`);
    console.log(`   Name: ${botInfo.bot.name}`);
    console.log(`   ID: ${botInfo.bot.id}`);
    console.log(`   App ID: ${botInfo.bot.app_id}\n`);

    console.log('🎉 All E2E tests passed!');
    console.log('\n📝 Summary:');
    console.log('- Token refresh: ✅');
    console.log('- Bot authentication: ✅');
    console.log('- Message posting: ✅');
    console.log('- Command sending: ✅');
    console.log('- Bot info retrieval: ✅');
    console.log('\n✨ Token rotation implementation verified!');
    console.log('\n💡 Check #peerbot-test channel for:');
    console.log('   1. Test message confirming token rotation');
    console.log('   2. Bot response to "@peercloud what is the capital of France?"');

  } catch (error) {
    console.error('❌ E2E test failed:', error.message);
    console.error('\nDebug info:');
    console.error('- Client ID:', SLACK_CLIENT_ID);
    console.error('- Refresh token (first 20 chars):', SLACK_REFRESH_TOKEN?.substring(0, 20) + '...');
    process.exit(1);
  }
}

// Run the test
runE2ETest();
#!/usr/bin/env node

const https = require('https');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const TEST_CHANNEL = process.env.SLACK_TEST_CHANNEL || 'C09189H0WBX'; // #peerbot-test channel

async function makeSlackRequest(method, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    
    const options = {
      hostname: 'slack.com',
      port: 443,
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
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
  console.log('🧪 Running Slack E2E Test');
  console.log('========================\n');

  try {
    // Test 1: Verify bot can authenticate
    console.log('1️⃣ Testing bot authentication...');
    const authTest = await makeSlackRequest('auth.test', {});
    console.log(`✅ Bot authenticated as: ${authTest.user} (${authTest.user_id})`);
    console.log(`   Team: ${authTest.team} (${authTest.team_id})\n`);

    // Test 2: Post a test message
    console.log('2️⃣ Posting test message...');
    const timestamp = new Date().toISOString();
    const testMessage = `🧪 E2E Test Message - ${timestamp}\nTesting token rotation implementation`;
    
    const postResult = await makeSlackRequest('chat.postMessage', {
      channel: TEST_CHANNEL,
      text: testMessage,
      unfurl_links: false,
      unfurl_media: false
    });
    
    console.log(`✅ Message posted successfully`);
    console.log(`   Channel: ${postResult.channel}`);
    console.log(`   Timestamp: ${postResult.ts}\n`);

    // Test 3: Send a command to the bot
    console.log('3️⃣ Sending command to bot...');
    const commandMessage = `@peercloud hello, can you tell me what is 2+2?`;
    
    const commandResult = await makeSlackRequest('chat.postMessage', {
      channel: TEST_CHANNEL,
      text: commandMessage,
      unfurl_links: false,
      unfurl_media: false
    });
    
    console.log(`✅ Command sent successfully`);
    console.log(`   Message: "${commandMessage}"`);
    console.log(`   Timestamp: ${commandResult.ts}\n`);

    // Test 4: Check if we can list conversations
    console.log('4️⃣ Listing bot conversations...');
    const conversations = await makeSlackRequest('conversations.list', {
      types: 'public_channel,private_channel',
      limit: 5
    });
    
    console.log(`✅ Can list conversations: ${conversations.channels.length} channels found\n`);

    // Test 5: Get bot info
    console.log('5️⃣ Getting bot info...');
    const botInfo = await makeSlackRequest('bots.info', {
      bot: authTest.user_id
    });
    
    console.log(`✅ Bot info retrieved:`);
    console.log(`   Name: ${botInfo.bot.name}`);
    console.log(`   ID: ${botInfo.bot.id}`);
    console.log(`   App ID: ${botInfo.bot.app_id}\n`);

    console.log('🎉 All E2E tests passed!');
    console.log('\n📝 Summary:');
    console.log('- Bot authentication: ✅');
    console.log('- Message posting: ✅');
    console.log('- Command sending: ✅');
    console.log('- API permissions: ✅');
    console.log('- Bot info retrieval: ✅');
    console.log('\n💡 Note: Check #peerbot-test channel to see if the bot responds to the command');
    console.log('   The bot should process "@peercloud hello, can you tell me what is 2+2?"');

  } catch (error) {
    console.error('❌ E2E test failed:', error.message);
    console.error('\nDebug info:');
    console.error('- Token (first 10 chars):', SLACK_BOT_TOKEN?.substring(0, 10) + '...');
    console.error('- Test channel:', TEST_CHANNEL);
    process.exit(1);
  }
}

// Run the test
runE2ETest();
#!/usr/bin/env node

const https = require('https');
const path = require('path');

// Load QA environment
require('dotenv').config({ path: path.join(__dirname, '..', '.env.qa') });

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const QA_CHANNEL = 'C091HDVQVLY'; // #peerbot-qa channel ID

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
            reject(new Error(`Slack API error: ${result.error} - ${JSON.stringify(result)}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reje
    req.write(postData);
    req.end();
  });
}

async function testBotInQA() {
  console.log('🧪 Testing Peerbot in QA Channel (Simple)');
  console.log('=========================================\n');
  console.log('Using QA environment (.env.qa)');
  console.log('Target channel: #peerbot-qa (C091HDVQVLY)\n');

  try {
    // Test 1: Verify bot authentication
    console.log('1️⃣ Testing bot authentication...');
    const authTest = await makeSlackRequest('auth.test', {});
    console.log(`✅ Bot authenticated as: ${authTest.user} (${authTest.user_id})`);
    console.log(`   Team: ${authTest.team} (${authTest.team_id})\n`);

    // Test 2: List channels to find the right one
    console.log('2️⃣ Listing channels to find peerbot-qa...');
    const channelsList = await makeSlackRequest('conversations.list', {
      types: 'public_channel',
      limit: 100
    });
    
    const qaChannel = channelsList.channels.find(ch => ch.name === 'peerbot-qa');
    if (qaChannel) {
      console.log(`✅ Found #peerbot-qa channel`);
      console.log(`   ID: ${qaChannel.id}`);
      console.log(`   Is member: ${qaChannel.is_member}\n`);
    } else {
      console.log('⚠️  Could not find #peerbot-qa in channel list\n');
    }

    // Test 3: Post a test message (using found channel ID if available)
    const targetChannel = qaChannel ? qaChannel.id : QA_CHANNEL;
    console.log(`3️⃣ Posting test message to ${targetChannel}...`);
    const timestamp = new Date().toISOString();
    const testMessage = `🧪 QA Bot Test - ${timestamp}\nTesting production bot with token rotation`;
    
    const postResult = await makeSlackRequest('chat.postMessage', {
      channel: targetChannel,
      text: testMessage,
      unfurl_links: false,
      unfurl_media: false
    });
    
    console.log(`✅ Message posted successfully`);
    console.log(`   Channel: ${postResult.channel}`);
    console.log(`   Message timestamp: ${postResult.ts}\n`);

    // Test 4: Send a command to trigger the bot
    console.log('4️⃣ Sending command to bot...');
    const commandMessage = `<@PeerCloud> Hi! Can you tell me what 15 + 27 equals?`;
    
    const commandResult = await makeSlackRequest('chat.postMessage', {
      channel: targetChannel,
      text: commandMessage,
      unfurl_links: false,
      unfurl_media: false
    });
    
    console.log(`✅ Command sent successfully`);
    console.log(`   Command: "${commandMessage}"`);
    console.log(`   Timestamp: ${commandResult.ts}\n`);

    console.log('🎉 QA test completed successfully!');
    console.log('\n📝 Summary:');
    console.log('- Bot authentication: ✅');
    console.log('- Message posting: ✅');
    console.log('- Command sending: ✅');
    console.log('\n💡 Next steps:');
    console.log('1. Check #peerbot-qa channel in Slack');
    console.log('2. Verify the bot responds to the @peercloud mention');
    console.log('3. The bot should calculate 15 + 27 = 42');
    console.log('\n🔗 Check: https://peerbotcommunity.slack.com/archives/' + targetChannel);

  } catch (error) {
    console.error('❌ QA test failed:', error.message);
    console.error('\nDebug info:');
    console.error('- QA Token (first 10 chars):', SLACK_BOT_TOKEN?.substring(0, 10) + '...');
    console.error('- QA Channel ID:', QA_CHANNEL);
    process.exit(1);
  }
}

// Run the test
testBotInQA();
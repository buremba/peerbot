#!/usr/bin/env node

const https = require('https');
const path = require('path');

// Load environment - can be overridden with --qa flag
const isQA = process.argv.includes('--qa');
if (isQA) {
  console.log('🔧 Using QA environment (.env.qa)');
  require('dotenv').config({ path: path.join(__dirname, '.env.qa') });
} else {
  console.log('🔧 Using production environment (.env)');
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || process.env.SLACK_REFRESH_TOKEN;
const SLACK_TRIGGER_PHRASE = process.env.SLACK_TRIGGER_PHRASE || '@peercloud';

// Channel IDs
const CHANNELS = {
  qa: 'C0952LTF7DG',     // #peerbot-qa
  general: 'C091TBW0X58', // #general (adjust as needed)
  test: 'C0952LTF7DG'     // Use qa channel for testing
};

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

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function waitForBotResponse(channel, afterTimestamp, timeout = 30000) {
  console.log('⏳ Waiting for bot response...');
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const history = await makeSlackRequest('conversations.history', {
        channel: channel,
        oldest: afterTimestamp,
        limit: 10
      });
      
      // Look for messages from bots or containing Claude
      const botMessages = history.messages.filter(msg => 
        msg.bot_id || // any bot message
        (msg.text && msg.text.includes('Claude')) || // Claude response
        (msg.text && msg.text.includes('Processing')) || // Processing message
        (msg.user && msg.user !== history.messages[history.messages.length - 1].user) // Different user
      );
      
      if (botMessages.length > 0) {
        return botMessages;
      }
    } catch (error) {
      console.error('Error checking for response:', error.message);
    }
    
    // Wait 2 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  return null;
}

async function checkBotHealth() {
  console.log('\n🏥 Checking bot health...');
  
  try {
    const webhookUrl = 'https://slack.peerbot.ai/slack/events';
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Signature': 'v0=invalid',
        'X-Slack-Request-Timestamp': Math.floor(Date.now() / 1000).toString()
      },
      body: JSON.stringify({ test: true })
    });
    
    if (response.status === 401) {
      console.log('✅ Bot webhook is active (returning 401 for invalid signature)');
      return true;
    } else {
      console.log(`⚠️  Unexpected webhook status: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error('❌ Bot webhook check failed:', error.message);
    return false;
  }
}

async function runTests() {
  console.log('🧪 Comprehensive Peerbot Test Suite');
  console.log('=====================================\n');
  
  const targetChannel = isQA ? CHANNELS.qa : CHANNELS.test;
  const channelName = isQA ? '#peerbot-qa' : '#peerbot-qa';
  
  try {
    // Check bot health first
    const isHealthy = await checkBotHealth();
    if (!isHealthy) {
      console.log('\n⚠️  Warning: Bot webhook may not be responding correctly\n');
    }
    
    // Test 1: Verify bot authentication
    console.log('1️⃣ Testing bot authentication...');
    const authTest = await makeSlackRequest('auth.test', {});
    const botUserId = authTest.user_id;
    console.log(`✅ Bot authenticated as: ${authTest.user} (${botUserId})`);
    console.log(`   Team: ${authTest.team} (${authTest.team_id})\n`);

    // Test 2: Find bot user for mentions
    console.log('2️⃣ Finding bot user for mentions...');
    const usersList = await makeSlackRequest('users.list', {});
    const triggerUser = usersList.members.find(u => 
      u.name === SLACK_TRIGGER_PHRASE.replace('@', '') || 
      u.real_name === SLACK_TRIGGER_PHRASE.replace('@', '') || 
      u.profile?.display_name === SLACK_TRIGGER_PHRASE.replace('@', '')
    );
    
    const mention = triggerUser ? `<@${triggerUser.id}>` : SLACK_TRIGGER_PHRASE;
    console.log(`✅ Using mention: ${mention}`);
    console.log(`   Trigger phrase: ${SLACK_TRIGGER_PHRASE}\n`);

    // Test 3: Verify channel access
    console.log('3️⃣ Verifying channel access...');
    const channelInfo = await makeSlackRequest('conversations.info', {
      channel: targetChannel
    });
    console.log(`✅ Channel: ${channelName} (${targetChannel})`);
    console.log(`   Bot is member: ${channelInfo.channel.is_member || 'unknown'}\n`);

    // Test 4: Simple math question
    console.log('4️⃣ Testing simple math question...');
    const question1 = `${mention} What is 2 + 2?`;
    const msg1 = await makeSlackRequest('chat.postMessage', {
      channel: targetChannel,
      text: question1,
      unfurl_links: false,
      unfurl_media: false
    });
    console.log(`✅ Sent: "${question1}"`);
    
    const response1 = await waitForBotResponse(targetChannel, msg1.ts);
    if (response1 && response1.length > 0) {
      console.log(`✅ Bot responded: "${response1[0].text?.substring(0, 100)}..."\n`);
    } else {
      console.log('⚠️  No bot response received within 30 seconds\n');
    }

    // Test 5: Knowledge question
    console.log('5️⃣ Testing knowledge question...');
    const question2 = `${mention} What is the capital of France?`;
    const msg2 = await makeSlackRequest('chat.postMessage', {
      channel: targetChannel,
      text: question2,
      unfurl_links: false,
      unfurl_media: false
    });
    console.log(`✅ Sent: "${question2}"`);
    
    const response2 = await waitForBotResponse(targetChannel, msg2.ts);
    if (response2 && response2.length > 0) {
      console.log(`✅ Bot responded: "${response2[0].text?.substring(0, 100)}..."\n`);
    } else {
      console.log('⚠️  No bot response received within 30 seconds\n');
    }

    // Test 6: Complex calculation
    console.log('6️⃣ Testing complex calculation...');
    const question3 = `${mention} Please calculate: 123 × 456`;
    const msg3 = await makeSlackRequest('chat.postMessage', {
      channel: targetChannel,
      text: question3,
      unfurl_links: false,
      unfurl_media: false
    });
    console.log(`✅ Sent: "${question3}"`);
    
    const response3 = await waitForBotResponse(targetChannel, msg3.ts);
    if (response3 && response3.length > 0) {
      console.log(`✅ Bot responded: "${response3[0].text?.substring(0, 100)}..."\n`);
    } else {
      console.log('⚠️  No bot response received within 30 seconds\n');
    }

    // Summary
    console.log('🎉 Test completed!');
    console.log('\n📝 Summary:');
    console.log(`- Environment: ${isQA ? 'QA' : 'Production'}`);
    console.log(`- Channel: ${channelName} (${targetChannel})`);
    console.log(`- Bot mention: ${mention}`);
    console.log(`- Webhook health: ${isHealthy ? '✅' : '⚠️'}`);
    console.log('- Questions sent: 3');
    
    const totalResponses = [response1, response2, response3].filter(r => r && r.length > 0).length;
    console.log(`- Responses received: ${totalResponses}/3`);
    console.log(`\n🔗 Channel: https://peerbotcommunity.slack.com/archives/${targetChannel}`);

    // Troubleshooting help
    if (totalResponses === 0) {
      console.log('\n⚠️  Troubleshooting: Bot did not respond to any messages');
      console.log('\nPossible issues:');
      console.log('1. Check if bot is running: kubectl get pods -n peerbot');
      console.log('2. Check bot logs: kubectl logs -n peerbot -l app.kubernetes.io/component=dispatcher --tail=50');
      console.log('3. Verify trigger phrase matches: ' + SLACK_TRIGGER_PHRASE);
      console.log('4. Check if bot has access to channel');
      console.log('5. Verify Slack tokens are valid and not expired');
      console.log('\nTo run with QA environment: node test-bot.js --qa');
    } else if (totalResponses < 3) {
      console.log('\n⚠️  Some responses were missed. Check bot logs for errors.');
    }

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nDebug info:');
    console.error('- Token (first 10 chars):', SLACK_BOT_TOKEN?.substring(0, 10) + '...');
    console.error('- Target channel:', targetChannel);
    console.error('- Trigger phrase:', SLACK_TRIGGER_PHRASE);
    process.exit(1);
  }
}

// Check Kubernetes status
async function checkKubernetesStatus() {
  console.log('\n🚀 Checking Kubernetes deployment status...\n');
  
  const { execSync } = require('child_process');
  
  try {
    // Check pods
    console.log('📦 Pods in peerbot namespace:');
    const pods = execSync('kubectl get pods -n peerbot -o wide', { encoding: 'utf8' });
    console.log(pods);
    
    // Check recent events
    console.log('📅 Recent events:');
    const events = execSync('kubectl get events -n peerbot --sort-by=.lastTimestamp | tail -5', { encoding: 'utf8' });
    console.log(events);
  } catch (error) {
    console.log('⚠️  Could not check Kubernetes status (kubectl may not be available)');
  }
}

// Main execution
(async () => {
  if (process.argv.includes('--k8s')) {
    await checkKubernetesStatus();
  }
  
  await runTests();
})();
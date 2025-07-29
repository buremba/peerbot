const { WebClient } = require('@slack/web-api');

// Test Slack authentication
async function testSlackAuth() {
  const token = process.env.SLACK_BOT_TOKEN || 'xoxb-1-MS0yLTkxNzExMTk0NjYyNDUtOTE3NjE2ODkwMzcxOS05MjgxMjA4NDEyNDQ5LTkyODEyMDg0NDM0NzMtZWVmNzE5ZjU5N2MyNTQxNzFlZjYxNmI3YzMyMTdmMzI3Nzg5NjJhMDVmOGQxNmUwMjdjMWJiYTcxMGQ5NGQ0MQ';
  
  console.log('Testing Slack authentication...');
  console.log('Token prefix:', token.substring(0, 20) + '...');
  
  const client = new WebClient(token);
  
  try {
    // Test auth
    const authResult = await client.auth.test();
    console.log('✅ Authentication successful!');
    console.log('Team:', authResult.team);
    console.log('User:', authResult.user);
    console.log('Bot ID:', authResult.user_id);
    
    // Get bot info
    const botInfo = await client.bots.info({ bot: authResult.user_id });
    console.log('Bot name:', botInfo.bot.name);
    
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    if (error.data) {
      console.error('Error details:', error.data);
    }
  }
}

testSlackAuth();
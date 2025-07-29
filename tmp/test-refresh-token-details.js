#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function testRefreshToken() {
  console.log('🔍 Testing Slack Refresh Token Details');
  console.log('=====================================\n');

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: process.env.SLACK_REFRESH_TOKEN
  });

  console.log('📤 Request parameters:');
  console.log(`   Client ID: ${process.env.SLACK_CLIENT_ID}`);
  console.log(`   Refresh Token: ${process.env.SLACK_REFRESH_TOKEN.substring(0, 30)}...`);

  try {
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    const data = await response.json();
    
    console.log('\n📥 Response:');
    console.log(JSON.stringify(data, null, 2));
    
    if (data.ok && data.access_token) {
      console.log('\n✅ Token refresh successful!');
      console.log(`   Access Token: ${data.access_token.substring(0, 50)}...`);
      console.log(`   Token Type: ${data.token_type || 'bot'}`);
      console.log(`   Expires In: ${data.expires_in} seconds (${data.expires_in / 3600} hours)`);
      
      // Test the new token
      console.log('\n🧪 Testing new token with auth.test...');
      const { WebClient } = require('@slack/web-api');
      const client = new WebClient(data.access_token);
      
      try {
        const authTest = await client.auth.test();
        console.log('✅ Auth test successful:');
        console.log(JSON.stringify(authTest, null, 2));
      } catch (error) {
        console.error('❌ Auth test failed:', error.message);
        
        // Try with the token in a different format
        if (data.access_token.startsWith('xoxe.')) {
          console.log('\n🔄 Trying with token without xoxe prefix...');
          const tokenWithoutPrefix = data.access_token.substring(5); // Remove "xoxe."
          const client2 = new WebClient(tokenWithoutPrefix);
          
          try {
            const authTest2 = await client2.auth.test();
            console.log('✅ Auth test successful with modified token:');
            console.log(JSON.stringify(authTest2, null, 2));
          } catch (error2) {
            console.error('❌ Auth test failed with modified token:', error2.message);
          }
        }
      }
    } else {
      console.error('❌ Token refresh failed:', data);
    }
    
  } catch (error) {
    console.error('❌ Request failed:', error);
  }
}

// Run test
testRefreshToken().catch(console.error);
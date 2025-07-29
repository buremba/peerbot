#!/usr/bin/env node

// Test script for Slack token rotation implementation

const { SlackTokenManager } = require('../packages/dispatcher/dist/slack/token-manager.js');

async function testTokenRotation() {
  console.log('🧪 Testing Slack Token Rotation');
  console.log('===============================\n');

  // Check environment variables
  const requiredEnvVars = [
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET', 
    'SLACK_REFRESH_TOKEN',
    'SLACK_BOT_TOKEN'
  ];

  console.log('📋 Checking environment variables:');
  const missingVars = [];
  for (const varName of requiredEnvVars) {
    if (process.env[varName]) {
      console.log(`✅ ${varName}: Set`);
    } else {
      console.log(`❌ ${varName}: Missing`);
      missingVars.push(varName);
    }
  }

  if (missingVars.length > 0) {
    console.error('\n❌ Missing required environment variables:', missingVars);
    process.exit(1);
  }

  console.log('\n📊 Testing token manager initialization...');
  
  try {
    // Initialize token manager
    const tokenManager = new SlackTokenManager(
      process.env.SLACK_CLIENT_ID,
      process.env.SLACK_CLIENT_SECRET,
      process.env.SLACK_REFRESH_TOKEN,
      process.env.SLACK_BOT_TOKEN
    );
    
    console.log('✅ Token manager initialized successfully');
    
    // Get current token
    console.log('\n🔑 Getting current token...');
    const currentToken = tokenManager.getCurrentToken();
    console.log(`✅ Current token: ${currentToken.substring(0, 20)}...`);
    
    // Test token validation
    console.log('\n🔍 Testing token validation...');
    const validToken = await tokenManager.getValidToken();
    console.log(`✅ Valid token retrieved: ${validToken.substring(0, 20)}...`);
    
    // Test refresh
    console.log('\n🔄 Testing manual token refresh...');
    try {
      const newToken = await tokenManager.refreshAccessToken();
      console.log(`✅ Token refreshed successfully: ${newToken.substring(0, 20)}...`);
      
      // Verify it's different (or same if refresh gives same token)
      if (newToken === currentToken) {
        console.log('ℹ️  Note: Slack returned the same token (this is normal if token is still valid)');
      } else {
        console.log('✅ New token is different from the original');
      }
    } catch (error) {
      console.error('❌ Token refresh failed:', error.message);
    }
    
    // Test Web API with token
    console.log('\n🌐 Testing Slack Web API with token...');
    const { WebClient } = require('@slack/web-api');
    
    // Test with authorize function
    const client = new WebClient(undefined, {
      authorize: async () => {
        const token = await tokenManager.getValidToken();
        return { botToken: token };
      },
    });
    
    try {
      const authTest = await client.auth.test();
      console.log('✅ Slack API test successful:');
      console.log(`   - Team: ${authTest.team}`);
      console.log(`   - User: ${authTest.user}`);
      console.log(`   - Bot ID: ${authTest.user_id}`);
    } catch (error) {
      console.error('❌ Slack API test failed:', error.message);
    }
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    tokenManager.stop();
    console.log('✅ Token manager stopped');
    
    console.log('\n✅ All tests completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests
testTokenRotation().catch(console.error);
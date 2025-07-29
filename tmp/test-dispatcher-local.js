#!/usr/bin/env node

// Load environment variables
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Set HTTP mode for local testing
process.env.SLACK_HTTP_MODE = 'true';

// Start the dispatcher
require('../packages/dispatcher/src/index.ts');
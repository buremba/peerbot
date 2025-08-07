#!/usr/bin/env node
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.qa') });
const token = process.env.SLACK_BOT_TOKEN;

function post(method, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, res => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        const json = JSON.parse(result);
        json.ok ? resolve(json) : reject(new Error(json.error));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('Testing bot...');
  const msg = await post('chat.postMessage', {
    channel: 'C0952LTF7DG',
    text: '<@U097WU1GMLJ> What is 2 + 2?'
  });
  console.log('Message sent:', msg.ts);
  console.log('Check: kubectl get pods -n peerbot | grep claude-worker');
})().catch(console.error);
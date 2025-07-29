const https = require('https');

const apiKey = 'c13507bb0268ff32e80aeb3bdeb10ca40207a';
const email = 'burak@peerbot.ai';
const newIP = '34.63.46.70';

// First, get the zone ID
const getZoneId = () => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      path: '/client/v4/zones?name=peerbot.ai',
      method: 'GET',
      headers: {
        'X-Auth-Email': email,
        'X-Auth-Key': apiKey,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (result.success && result.result.length > 0) {
          resolve(result.result[0].id);
        } else {
          reject(new Error('Failed to get zone ID: ' + JSON.stringify(result)));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
};

// Get DNS records for the zone
const getDNSRecords = (zoneId) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4/zones/${zoneId}/dns_records?name=slack.peerbot.ai`,
      method: 'GET',
      headers: {
        'X-Auth-Email': email,
        'X-Auth-Key': apiKey,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (result.success) {
          resolve(result.result);
        } else {
          reject(new Error('Failed to get DNS records: ' + JSON.stringify(result)));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
};

// Create or update DNS record
const updateDNSRecord = (zoneId, recordId = null) => {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      type: 'A',
      name: 'slack',
      content: newIP,
      ttl: 120,
      proxied: false
    });

    const options = {
      hostname: 'api.cloudflare.com',
      path: recordId 
        ? `/client/v4/zones/${zoneId}/dns_records/${recordId}`
        : `/client/v4/zones/${zoneId}/dns_records`,
      method: recordId ? 'PUT' : 'POST',
      headers: {
        'X-Auth-Email': email,
        'X-Auth-Key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (result.success) {
          resolve(result.result);
        } else {
          reject(new Error('Failed to update DNS: ' + JSON.stringify(result)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
};

// Main execution
async function main() {
  try {
    console.log('Getting zone ID for peerbot.ai...');
    const zoneId = await getZoneId();
    console.log('Zone ID:', zoneId);

    console.log('\nChecking existing DNS records...');
    const records = await getDNSRecords(zoneId);
    
    if (records.length > 0) {
      console.log('Found existing record:', records[0].content);
      console.log('Updating to new IP:', newIP);
      const result = await updateDNSRecord(zoneId, records[0].id);
      console.log('\n✅ DNS record updated successfully!');
      console.log('slack.peerbot.ai now points to:', result.content);
    } else {
      console.log('No existing record found, creating new one...');
      const result = await updateDNSRecord(zoneId);
      console.log('\n✅ DNS record created successfully!');
      console.log('slack.peerbot.ai now points to:', result.content);
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  }
}

main();
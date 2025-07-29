// Simple concatenation build for dispatcher
const fs = require('fs');
const path = require('path');

// Read the main index file
let content = fs.readFileSync('./src/index.ts', 'utf8');

// Add health endpoints directly in the start method
const healthEndpoints = `
    // Add health check endpoints for HTTP mode
    if (\!this.config.slack.socketMode) {
      const receiver = this.app.receiver as any;
      if (receiver && receiver.app) {
        const expressApp = receiver.app;
        
        // Health check endpoint
        expressApp.get('/health', (req: any, res: any) => {
          res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
        });
        
        // Readiness check
        expressApp.get('/ready', (req: any, res: any) => {
          res.status(200).json({ ready: true });
        });
        
        console.log('Health endpoints configured: GET /health, GET /ready');
      }
    }
`;

// Insert health endpoints in the start method
content = content.replace(
  'const startMessage = this.config.slack.socketMode',
  healthEndpoints + '\n\n    const startMessage = this.config.slack.socketMode'
);

// Write to dist
fs.mkdirSync('./dist', { recursive: true });
fs.writeFileSync('./dist/index.js', content);

console.log('Simple build complete');

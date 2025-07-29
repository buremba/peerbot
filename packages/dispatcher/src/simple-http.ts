import http from 'http';

let healthServer: http.Server | null = null;

export function setupHealthEndpoints() {
  if (healthServer) return;
  
  // Create a simple HTTP server for health checks
  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else if (req.url === '/ready' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: true }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  
  // Listen on a different port for health checks
  const healthPort = 8080;
  healthServer.listen(healthPort, () => {
    console.log(`Health check server listening on port ${healthPort}`);
  });
}
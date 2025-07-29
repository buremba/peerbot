"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupHealthEndpoints = setupHealthEndpoints;
const http_1 = __importDefault(require("http"));
let healthServer = null;
function setupHealthEndpoints() {
    if (healthServer)
        return;
    // Create a simple HTTP server for health checks
    healthServer = http_1.default.createServer((req, res) => {
        if (req.url === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        }
        else if (req.url === '/ready' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ready: true }));
        }
        else {
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
//# sourceMappingURL=simple-http.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupHttpServer = setupHttpServer;
function setupHttpServer(app, port) {
    // Get the Express receiver from Bolt
    const receiver = app.receiver;
    if (!receiver || !receiver.router) {
        console.error('Unable to set up HTTP endpoints: ExpressReceiver not found');
        return;
    }
    const expressApp = receiver.router;
    // Add health check endpoint
    expressApp.get('/health', (req, res) => {
        res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    // Add readiness check
    expressApp.get('/ready', (req, res) => {
        res.status(200).json({ ready: true });
    });
    console.log(`HTTP endpoints configured:`);
    console.log(`- Health check: GET /health`);
    console.log(`- Readiness: GET /ready`);
    console.log(`- Slack events: POST /slack/events (handled by Bolt)`);
}
//# sourceMappingURL=http-server.js.map
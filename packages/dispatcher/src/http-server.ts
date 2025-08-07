import type { App, ExpressReceiver } from '@slack/bolt';
import logger from './logger';

export function setupHttpServer(app: App) {
  // Get the Express receiver from Bolt
  const receiver = (app as any).receiver as ExpressReceiver;
  
  if (!receiver || !receiver.router) {
    logger.error('Unable to set up HTTP endpoints: ExpressReceiver not found');
    return;
  }
  
  const expressApp = receiver.router;
  
  // Add health check endpoint
  expressApp.get('/health', (_req: any, res: any) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  
  // Add readiness check
  expressApp.get('/ready', (_req: any, res: any) => {
    res.status(200).json({ ready: true });
  });
  
  logger.info(`HTTP endpoints configured:`);
  logger.info(`- Health check: GET /health`);
  logger.info(`- Readiness: GET /ready`);
  logger.info(`- Slack events: POST /slack/events (handled by Bolt)`);
}
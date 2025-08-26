import { createLogger } from '@claude-code-slack/shared-logger';

const logger = createLogger({ service: 'worker' });

export default logger;
import { createLogger } from '@claude-code-slack/shared-logger';

const logger = createLogger({ service: 'dispatcher', useBundled: true });

export default logger;
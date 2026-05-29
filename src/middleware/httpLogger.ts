import morgan from 'morgan';
import { Request } from 'express';
import logger from '../utils/logger';

// Stream adapter so morgan writes through Winston
const stream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};

// Skip health-check noise in all environments
const skip = (req: Request) => req.path === '/health';

// dev: concise coloured; prod: Apache combined for log parsers
const format = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';

const httpLogger = morgan(format, { stream, skip });

export default httpLogger;

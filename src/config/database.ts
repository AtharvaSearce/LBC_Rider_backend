import { prisma } from '../lib/prisma';
import logger from '../utils/logger';

export async function connectDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  try {
    console.log("HERE");
    await prisma.$connect();
    logger.info('[PostgreSQL] Connected via Prisma');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[PostgreSQL] Connection error', { message });
    throw err;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('[PostgreSQL] Disconnected');
}

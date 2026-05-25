import { prisma } from '../lib/prisma';

export async function connectDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  try {
    await prisma.$connect();
    console.log('[PostgreSQL] Connected via Prisma');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[PostgreSQL] Connection error:', message);
    throw err;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  console.log('[PostgreSQL] Disconnected');
}

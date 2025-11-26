import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma = global.prisma || new PrismaClient({
  log: [
    {
      emit: 'event',
      level: 'query',
    },
    {
      emit: 'event',
      level: 'error',
    },
    {
      emit: 'event',
      level: 'info',
    },
    {
      emit: 'event',
      level: 'warn',
    },
  ],
});

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

// Log Prisma events
// @ts-ignore
prisma.$on('query', (e: any) => {
  if (process.env.LOG_LEVEL === 'debug') {
    logger.debug({
      query: e.query,
      params: e.params,
      duration: e.duration,
    }, 'Prisma Query');
  }
});

// @ts-ignore
prisma.$on('error', (e: any) => {
  logger.error(e, 'Prisma Error');
});

// @ts-ignore
prisma.$on('info', (e: any) => {
  logger.info(e, 'Prisma Info');
});

// @ts-ignore
prisma.$on('warn', (e: any) => {
  logger.warn(e, 'Prisma Warning');
});

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully');
  } catch (error) {
    logger.error(error, 'Failed to connect to database');
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    logger.info('Database disconnected successfully');
  } catch (error) {
    logger.error(error, 'Failed to disconnect from database');
    throw error;
  }
}

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error(error, 'Database health check failed');
    return false;
  }
}
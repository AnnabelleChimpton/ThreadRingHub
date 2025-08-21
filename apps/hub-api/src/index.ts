import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { config } from './config';
import { logger } from './utils/logger';

async function buildApp() {
  const fastify = Fastify({
    logger,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    disableRequestLogging: false,
    trustProxy: true,
  });

  // Register core plugins
  await fastify.register(sensible);
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Will configure properly later
  });
  await fastify.register(cors, {
    origin: config.cors.origins,
    credentials: true,
  });
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // Health check endpoints
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  fastify.get('/health/live', async () => {
    return { status: 'live', timestamp: new Date().toISOString() };
  });

  fastify.get('/health/ready', async (request, reply) => {
    // TODO: Check database connection
    // TODO: Check Redis connection
    const checks = {
      database: 'ok',
      redis: 'ok',
    };

    const allHealthy = Object.values(checks).every((status) => status === 'ok');

    if (!allHealthy) {
      reply.code(503);
    }

    return {
      status: allHealthy ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    };
  });

  // Graceful shutdown
  const closeGracefully = async (signal: string) => {
    fastify.log.info(`Received signal: ${signal}, closing gracefully...`);
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', () => closeGracefully('SIGINT'));
  process.on('SIGTERM', () => closeGracefully('SIGTERM'));

  return fastify;
}

async function start() {
  try {
    const fastify = await buildApp();
    const port = config.port;
    const host = config.host;

    await fastify.listen({ port, host });
    fastify.log.info(`Ring Hub API running at http://${host}:${port}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

start();
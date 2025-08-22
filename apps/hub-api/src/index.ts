import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config';
import { logger } from './utils/logger';
import { connectDatabase, disconnectDatabase, checkDatabaseHealth } from './database/prisma';
import { connectRedis, disconnectRedis, checkRedisHealth } from './database/redis';
import { ringsRoutes } from './routes/rings';

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

  // Swagger/OpenAPI documentation
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Ring Hub API',
        description: 'Decentralized community protocol for the open web',
        version: '0.1.0',
      },
      servers: [
        {
          url: `http://${config.host}:${config.port}`,
          description: 'Development server',
        },
      ],
      tags: [
        { name: 'health', description: 'Health check endpoints' },
        { name: 'rings', description: 'Ring management operations' },
        { name: 'membership', description: 'Membership operations' },
        { name: 'content', description: 'Content submission and curation' },
        { name: 'federation', description: 'Federation and ActivityPub' },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: true,
  });

  // Health check endpoints
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  fastify.get('/health/live', async () => {
    return { status: 'live', timestamp: new Date().toISOString() };
  });

  fastify.get('/health/ready', async (request, reply) => {
    const [dbHealthy, redisHealthy] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
    ]);

    const checks = {
      database: dbHealthy ? 'ok' : 'unhealthy',
      redis: redisHealthy ? 'ok' : 'unhealthy',
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

  // Register API routes
  await fastify.register(ringsRoutes, { prefix: '/trp' });

  // Graceful shutdown
  const closeGracefully = async (signal: string) => {
    fastify.log.info(`Received signal: ${signal}, closing gracefully...`);
    await fastify.close();
    await disconnectDatabase();
    await disconnectRedis();
    process.exit(0);
  };

  process.on('SIGINT', () => closeGracefully('SIGINT'));
  process.on('SIGTERM', () => closeGracefully('SIGTERM'));

  return fastify;
}

async function start() {
  try {
    // Connect to databases
    await connectDatabase();
    await connectRedis();

    const fastify = await buildApp();
    const port = config.port;
    const host = config.host;

    await fastify.listen({ port, host });
    fastify.log.info(`Ring Hub API running at http://${host}:${port}`);
    fastify.log.info(`API Documentation available at http://${host}:${port}/docs`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

start();
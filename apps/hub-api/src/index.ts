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
import { membershipRoutes } from './routes/membership';
import { contentRoutes } from './routes/content';
import { adminRoutes } from './routes/admin';
import { profileUpdateRoutes } from './routes/profile-updates';
import { resignBadges } from './utils/migration';

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
    max: 500, // Increased from 100 to accommodate authenticated API clients
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
        { name: 'badges', description: 'Badge issuance and verification' },
        { name: 'content', description: 'Content submission and curation' },
        { name: 'federation', description: 'Federation and ActivityPub' },
        { name: 'profile-updates', description: 'Federated profile update notifications' },
        { name: 'admin', description: 'Administrative operations' },
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

  fastify.get('/health/ready', async (_request, reply) => {
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
  await fastify.register(membershipRoutes, { prefix: '/trp' });
  await fastify.register(contentRoutes, { prefix: '/trp' });
  await fastify.register(profileUpdateRoutes, { prefix: '/trp' });
  await fastify.register(adminRoutes, { prefix: '/admin' });

  return fastify;
}

async function start() {
  try {
    const fastify = await buildApp();

    // Connect to databases
    await connectDatabase();
    await connectRedis();

    // Run badge re-signing migration on startup
    try {
      await resignBadges();
    } catch (error) {
      logger.error({ error }, 'Failed to resign badges');
    }

    // Start server
    const { host, port } = config;
    await fastify.listen({ host, port });

    fastify.log.info(`API Documentation available at http://${host}:${port}/docs`);

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

  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

start();
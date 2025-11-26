import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { logger } from './utils/logger';
import { connectDatabase, disconnectDatabase, checkDatabaseHealth } from './database/prisma';
import { connectRedis, disconnectRedis, checkRedisHealth } from './database/redis';
import { ringsRoutes } from './routes/rings';
import { membershipRoutes } from './routes/membership';
import { ringManagementRoutes } from './routes/ring-management';
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
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://esm.sh"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://esm.sh"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
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
      servers: config.env === 'production'
        ? [
            {
              url: config.hubUrl,
              description: 'Production server',
            },
          ]
        : [
            {
              url: `http://${config.host}:${config.port}`,
              description: 'Development server',
            },
            {
              url: config.hubUrl,
              description: 'Production server',
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

  // DID Generator page - serve HTML directly
  // Works in both dev (src/) and prod (dist/) by going up to project root
  fastify.get('/generator', async (_request, reply) => {
    // Try multiple possible locations
    const possiblePaths = [
      path.join(__dirname, '..', 'public', 'generator.html'),      // from src/
      path.join(__dirname, '..', '..', 'public', 'generator.html'), // from dist/
      path.join(process.cwd(), 'public', 'generator.html'),         // from project root
      path.join(process.cwd(), 'apps', 'hub-api', 'public', 'generator.html'), // from monorepo root
    ];

    for (const htmlPath of possiblePaths) {
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        return reply.type('text/html').send(html);
      }
    }

    reply.code(404).send({ error: 'Generator page not found' });
  });

  // Root redirect to docs
  fastify.get('/', async (_request, reply) => {
    return reply.redirect('/docs');
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
  await fastify.register(ringManagementRoutes, { prefix: '/trp' });
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
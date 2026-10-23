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

async function buildApp() {
  const fastify = Fastify({
    logger,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    disableRequestLogging: false,
    trustProxy: config.trustProxy,
  });

  // Capture the RAW request body bytes for JSON requests so HTTP-signature
  // Digest validation can hash the exact bytes the client signed. Fastify's
  // default JSON parser discards the raw payload; this replacement stashes it
  // on request.rawBody and still parses the JSON as normal.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      (req as any).rawBody = body;
      if (body.length === 0) {
        // Preserve Fastify's default behaviour for empty JSON bodies.
        done(null, undefined);
        return;
      }
      try {
        const json = JSON.parse(body.toString('utf8'));
        done(null, json);
      } catch (err) {
        (err as any).statusCode = 400;
        done(err as Error, undefined);
      }
    }
  );

  // Register core plugins
  await fastify.register(sensible);
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Disable CSP - swagger-ui needs inline scripts
  });
  await fastify.register(cors, {
    origin: config.cors.origins,
    credentials: true,
  });
  // Keyed by request.ip. Not keyed by actor DID: this runs before signature
  // verification, so a DID here would be an unverified claim anyone could use
  // to mint fresh buckets or to exhaust a trusted server's bucket.
  if (config.rateLimit.enabled) {
    // With trustProxy=true, request.ip is the client-supplied leftmost
    // X-Forwarded-For, so anyone could claim a trusted IP (and drain its
    // bucket). Trusted IPs only take effect once TRUST_PROXY is pinned.
    const trustedIps = new Set(config.trustProxy === true ? [] : config.rateLimit.trustedIps);
    if (config.trustProxy === true && config.rateLimit.trustedIps.length > 0) {
      logger.error('RATE_LIMIT_TRUSTED_IPS ignored: set TRUST_PROXY to the reverse proxy hop count or IP first');
    }
    await fastify.register(rateLimit, {
      max: (_request, key) => (trustedIps.has(key) ? config.rateLimit.trustedMax : config.rateLimit.max),
      timeWindow: '1 minute',
    });
  }

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
      components: {
        securitySchemes: {
          httpSignature: {
            type: 'apiKey',
            in: 'header',
            name: 'Signature',
            description: 'HTTP Signature authentication using Ed25519. Format: keyId="did:web:...",algorithm="ed25519",headers="(request-target) host date digest",signature="..."',
          },
        },
      },
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Helper to find and serve HTML files from public directory
  const servePublicHtml = (filename: string) => async (_request: any, reply: any) => {
    const possiblePaths = [
      path.join(__dirname, '..', 'public', filename),      // from src/
      path.join(__dirname, '..', '..', 'public', filename), // from dist/
      path.join(process.cwd(), 'public', filename),         // from project root
      path.join(process.cwd(), 'apps', 'hub-api', 'public', filename), // from monorepo root
    ];

    for (const htmlPath of possiblePaths) {
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        return reply.type('text/html').send(html);
      }
    }

    reply.code(404).send({ error: `${filename} not found` });
  };

  // Public pages
  fastify.get('/generator', servePublicHtml('generator.html'));
  fastify.get('/guide', servePublicHtml('guide.html'));

  // Root redirect to docs
  fastify.get('/', async (_request, reply) => {
    return reply.redirect('/docs');
  });

  // Badges issued before 2026-10 carry /badges/:id inside their signed
  // credential, so that id can't change; the route itself lives under /trp.
  fastify.get<{ Params: { id: string } }>('/badges/:id', async (request, reply) => {
    return reply.redirect(301, `/trp/badges/${encodeURIComponent(request.params.id)}`);
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
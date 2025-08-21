import { z } from 'zod';

const configSchema = z.object({
  env: z.enum(['development', 'test', 'production']).default('development'),
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default('0.0.0.0'),
  cors: z.object({
    origins: z.array(z.string()).default(['http://localhost:3000']),
  }),
  database: z.object({
    url: z.string().url().or(z.string().startsWith('postgresql://')),
  }),
  redis: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().default(6379),
    password: z.string().optional(),
  }),
  security: z.object({
    jwtSecret: z.string().min(32),
    bcryptRounds: z.number().int().min(10).max(15).default(12),
  }),
});

function loadConfig() {
  const env = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    cors: {
      origins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    },
    database: {
      url: process.env.DATABASE_URL || 'postgresql://ringhub:ringhub@localhost:5432/ringhub',
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
    },
    security: {
      jwtSecret: process.env.JWT_SECRET || 'change-me-in-production-please-use-a-real-secret',
      bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
    },
  };

  return configSchema.parse(env);
}

export const config = loadConfig();
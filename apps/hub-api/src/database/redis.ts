import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

let redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redis) {
    redis = new Redis(config.redis.url, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: false,
      // Redis here is a pure cache: a dead or zombied Redis must degrade to
      // cache misses, never hang requests. Without these, ioredis queues
      // commands indefinitely against a wedged connection (which once took
      // down DID resolution — and with it all authentication — for months).
      connectTimeout: 2000,
      commandTimeout: 1500,
      enableOfflineQueue: false,
    });

    redis.on('connect', () => {
      logger.info('Redis connected successfully');
    });

    redis.on('error', (error) => {
      logger.error(error, 'Redis connection error');
    });

    redis.on('close', () => {
      logger.warn('Redis connection closed');
    });

    redis.on('reconnecting', () => {
      logger.info('Redis reconnecting...');
    });
  }

  return redis;
}

export async function connectRedis(): Promise<void> {
  const client = getRedisClient();
  try {
    // With enableOfflineQueue disabled, ping() throws until the socket is
    // ready, so wait for the 'ready' event (bounded) rather than pinging blind.
    if (client.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis connect timeout')), 3000);
        client.once('ready', () => { clearTimeout(timer); resolve(); });
        client.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
    }
    logger.info('Redis connection established');
  } catch (error) {
    // Redis is a cache — a hub that can't reach it should still start and
    // serve requests (as cache misses), not crash-loop. ioredis keeps
    // reconnecting in the background.
    logger.error(error, 'Redis unavailable at startup — continuing without cache');
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    try {
      await redis.quit();
      redis = null;
      logger.info('Redis disconnected successfully');
    } catch (error) {
      logger.error(error, 'Failed to disconnect from Redis');
      throw error;
    }
  }
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const client = getRedisClient();
    const response = await client.ping();
    return response === 'PONG';
  } catch (error) {
    logger.error(error, 'Redis health check failed');
    return false;
  }
}

// Cache utility functions
export async function getCached<T>(key: string): Promise<T | null> {
  try {
    const client = getRedisClient();
    const data = await client.get(key);
    if (data) {
      return JSON.parse(data) as T;
    }
    return null;
  } catch (error) {
    logger.error({ error, key }, 'Failed to get cached data');
    return null;
  }
}

export async function setCached<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  try {
    const client = getRedisClient();
    const data = JSON.stringify(value);
    if (ttlSeconds) {
      await client.setex(key, ttlSeconds, data);
    } else {
      await client.set(key, data);
    }
  } catch (error) {
    logger.error({ error, key }, 'Failed to set cached data');
  }
}

export async function deleteCached(key: string): Promise<void> {
  try {
    const client = getRedisClient();
    await client.del(key);
  } catch (error) {
    logger.error({ error, key }, 'Failed to delete cached data');
  }
}

export async function invalidatePattern(pattern: string): Promise<void> {
  try {
    const client = getRedisClient();
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(...keys);
      logger.debug({ pattern, count: keys.length }, 'Invalidated cache keys');
    }
  } catch (error) {
    logger.error({ error, pattern }, 'Failed to invalidate cache pattern');
  }
}
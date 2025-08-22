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
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
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
    await client.ping();
    logger.info('Redis connection established');
  } catch (error) {
    logger.error(error, 'Failed to connect to Redis');
    throw error;
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
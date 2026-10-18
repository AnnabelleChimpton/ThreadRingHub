// Runs before every test file, before the app's modules (config.ts reads env).
import { testDatabaseUrl } from './database';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'route-tests-only-jwt-secret-not-for-production';
process.env.REDIS_URL = 'redis://127.0.0.1:6399'; // nothing listens here: no Redis
process.env.RATE_LIMIT_ENABLED = 'false';

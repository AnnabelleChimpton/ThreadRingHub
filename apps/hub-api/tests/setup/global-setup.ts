/**
 * Fresh database for the route tests: the real migration history
 * (`prisma migrate deploy`, as ./scripts/deploy.sh runs it), then the ring
 * search and Invitation migrations a second time to prove they are safe to
 * re-run (both already exist on production in some form).
 */
import { execSync } from 'child_process';
import path from 'path';
import { testDatabaseUrl } from './database';

export default function globalSetup(): void {
  const url = new URL(testDatabaseUrl());
  const dbName = url.pathname.slice(1);
  if (!dbName.includes('test')) {
    throw new Error(`Refusing to reset "${dbName}": the route-test database name must contain "test"`);
  }
  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const run = (cmd: string) =>
    execSync(cmd, {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  run(`psql "${admin}" -v ON_ERROR_STOP=1 -qc 'DROP DATABASE IF EXISTS "${dbName}"' -c 'CREATE DATABASE "${dbName}"'`);
  run('npx prisma migrate deploy');
  run('npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261018000000_add_ring_search_fts/migration.sql');
  run('npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261018120000_add_invitation/migration.sql');
}

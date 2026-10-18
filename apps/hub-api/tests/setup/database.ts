import os from 'os';

/** Throwaway database for the hub's route tests. Override with HUB_TEST_DATABASE_URL. */
export const TEST_DB_NAME = 'ringhub_routetest';

export function testDatabaseUrl(): string {
  return process.env.HUB_TEST_DATABASE_URL || `postgresql://${os.userInfo().username}@localhost:5432/${TEST_DB_NAME}`;
}

/**
 * Hub route tests against a real, throwaway Postgres database
 * (tests/setup/global-setup.ts). `npm test` in apps/hub-api.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    // @noble/* and nanoid ship ESM only, so they go through ts-jest too.
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: { allowJs: true, isolatedModules: true } }],
  },
  transformIgnorePatterns: ['/node_modules/(?!(@noble|nanoid)/)'],
  globalSetup: '<rootDir>/tests/setup/global-setup.ts',
  setupFiles: ['<rootDir>/tests/setup/env.ts'],
  // One database, so test files run one at a time.
  maxWorkers: 1,
};

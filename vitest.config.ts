import { defineConfig } from 'vitest/config';

/**
 * Projects (docs/TESTING.md):
 *  - unit:        shared/, client/, server/ unit tests       → `npm test`
 *  - circuits:    circuits/test (circom_tester)              → `npm run test:circuits`
 *  - integration: server/test/int (real sockets, :memory: DB) → `npm run test:int`
 * `npm test` runs unit + circuits (integration has its own script).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['shared/**/*.test.ts', 'client/src/**/*.test.ts', 'server/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'circuits',
          include: ['circuits/test/**/*.test.ts'],
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['server/test/int/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['shared/**/*.ts', 'server/src/**/*.ts', 'client/src/game/**/*.ts'],
      exclude: ['**/*.test.ts'],
    },
  },
});

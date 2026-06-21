/** @type {import('jest').Config} */
const base = require('./jest.config');

// Runs ONLY the real-server integration tests (opt-in). These need the SFTP test
// container running — see src/test/integration/README or the throw message in the
// test's beforeAll for how to start it. Invoke with: npm run test:integration
module.exports = {
  ...base,
  testMatch: ['**/src/test/integration/**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/.claude/worktrees/'],
  // Real network + connect/upload/stat round-trips need more than the 5s default.
  testTimeout: 30000
};

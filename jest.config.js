/** @type {import('jest').Config} */
module.exports = {
  passWithNoTests: true,
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/test/**/*.test.ts'],
  // Integration tests hit a real SFTP server and are opt-in via `npm run test:integration`
  // (jest.integration.config.js). Keep them out of the default, offline unit run.
  testPathIgnorePatterns: ['/node_modules/', '/.claude/worktrees/', '\\.integration\\.test\\.ts$'],
  // out/ is the tracker generator's tsc build (npm run tracker); its compiled
  // copy of the vscode manual mock races the real one in src/test/__mocks__
  // and intermittently wins, failing suites that rely on newer mock fields.
  modulePathIgnorePatterns: ['/.claude/worktrees/', '<rootDir>/out/'],
  moduleNameMapper: {
    // Mock the vscode module since it's only available inside VSCode
    '^vscode$': '<rootDir>/src/test/__mocks__/vscode.ts'
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/test/**', '!.claude/**']
};

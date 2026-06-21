/** @type {import('jest').Config} */
module.exports = {
  passWithNoTests: true,
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/test/**/*.test.ts'],
  // Integration tests hit a real SFTP server and are opt-in via `npm run test:integration`
  // (jest.integration.config.js). Keep them out of the default, offline unit run.
  testPathIgnorePatterns: ['/node_modules/', '/.claude/worktrees/', '\\.integration\\.test\\.ts$'],
  modulePathIgnorePatterns: ['/.claude/worktrees/'],
  moduleNameMapper: {
    // Mock the vscode module since it's only available inside VSCode
    vscode: '<rootDir>/src/test/__mocks__/vscode.ts'
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/test/**', '!.claude/**']
};

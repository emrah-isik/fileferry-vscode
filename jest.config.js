/** @type {import('jest').Config} */
module.exports = {
  passWithNoTests: true,
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/test/**/*.test.ts'],
  moduleNameMapper: {
    // Mock the vscode module since it's only available inside VSCode
    vscode: '<rootDir>/src/test/__mocks__/vscode.ts'
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/test/**']
};

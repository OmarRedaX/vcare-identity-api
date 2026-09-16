/** Integration tests: real wiring, real Postgres, real Redis (CLAUDE.md -> Testing policy). */
/** @type {import("jest").Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests/integration"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/setup.ts"],
  globalSetup: "<rootDir>/tests/integration/global-setup.ts",
  maxWorkers: 1,
  testTimeout: 20000,
};

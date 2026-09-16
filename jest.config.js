/** Unit tests: collaborators mocked, no infrastructure (CLAUDE.md -> Testing policy). */
/** @type {import("jest").Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests/unit"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/setup.ts"],
  clearMocks: true,
};

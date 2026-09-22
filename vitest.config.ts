import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/helpers/globalSetup.ts"],
    // Integration tests share one Postgres database and truncate between tests,
    // so test files must not run in parallel.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
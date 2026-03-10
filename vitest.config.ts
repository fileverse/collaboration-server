import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      reporter: ["lcov"],
    },
    environment: "node",
    include: ["src/tests/**/*.test.ts", "tests/**/*.test.ts"],
    globals: true,
  },
});


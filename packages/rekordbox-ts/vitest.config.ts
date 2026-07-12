import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      thresholds: {
        branches: 52,
        functions: 55,
        lines: 59,
        statements: 57,
      },
    },
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});

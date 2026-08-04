import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const tsconfig = JSON.parse(
  readFileSync(new URL("./tsconfig.cli.json", import.meta.url), "utf8"),
) as {
  compilerOptions: {
    baseUrl: string;
    paths: Record<string, [string]>;
  };
};
const baseUrl = resolve(import.meta.dirname, tsconfig.compilerOptions.baseUrl);

export default defineConfig({
  resolve: {
    alias: Object.entries(tsconfig.compilerOptions.paths)
      .sort(([left], [right]) => right.length - left.length)
      .map(([specifier, [target]]) => ({
        find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        replacement: resolve(baseUrl, target),
      })),
  },
});

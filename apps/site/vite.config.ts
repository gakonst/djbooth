import mdx from "@mdx-js/rollup";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    { enforce: "pre", ...mdx() },
    react({ include: /\.(?:jsx|tsx|mdx)$/u }),
  ],
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.MUSIC_LIBRARY_API_URL ?? "http://127.0.0.1:4179";

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: "dist/client",
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4180,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
});

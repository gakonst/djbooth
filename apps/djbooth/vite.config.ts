import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.MUSIC_LIBRARY_API_URL ?? "http://127.0.0.1:4180";
const hardwareTarget = process.env.DJBOOTH_STATE_API_URL ?? "http://127.0.0.1:4182";

const cloud = process.env.DJBOOTH_CLOUD_BUILD === "1";

export default defineConfig({
  base: cloud ? "/workstation/" : "/",
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: cloud ? "../cloud/public/workstation" : "dist/client",
    sourcemap: process.env.NODE_ENV !== "production",
  },
  server: {
    host: "127.0.0.1",
    port: 4179,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
        ws: true,
      },
      "/v1": {
        target: hardwareTarget,
        ws: true,
      },
    },
  },
});

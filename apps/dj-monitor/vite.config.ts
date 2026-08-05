import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const monitorTarget = process.env.DJ_MONITOR_URL ?? "http://127.0.0.1:4182";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4183,
    strictPort: true,
    proxy: {
      "/api": monitorTarget,
      "/v1": {
        target: monitorTarget,
        ws: true,
      },
    },
  },
});

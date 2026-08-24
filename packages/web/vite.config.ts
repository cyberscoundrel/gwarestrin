import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3100", changeOrigin: true },
      "/ws": { target: "ws://localhost:3100", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});

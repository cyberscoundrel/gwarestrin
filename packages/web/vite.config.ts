import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Dev proxy target. GW_BACKEND points the dev server at another backend
// (e.g. a remote instance); the ws target is derived from it.
const backend = process.env.GW_BACKEND ?? "http://localhost:3100";
const wsBackend = backend.replace(/^http/, "ws");
// Optional fake identity for local dev: injected as the header the
// Authentik outpost would normally set, so /api/me resolves a user.
const devUser = process.env.GW_DEV_USER;
const devHeaders = devUser ? { headers: { "X-authentik-username": devUser } } : {};

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true, ...devHeaders },
      "/ws": { target: wsBackend, ws: true, ...devHeaders },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          for (const pkg of ["pdfjs-dist", "xlsx", "ollama", "@lmstudio", "docx-preview", "jszip", "lucide"]) {
            if (id.includes(pkg)) return `vendor-${pkg.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
          }
          if (id.includes("pi-web-ui") || id.includes("pi-ai") || id.includes("pi-tui") || id.includes("mini-lit") || id.includes("/lit/")) {
            return "vendor-pi-web-ui";
          }
          return undefined;
        },
      },
    },
  },
});

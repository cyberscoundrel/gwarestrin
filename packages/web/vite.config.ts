import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3100", changeOrigin: true },
      "/ws": { target: "ws://localhost:3100", ws: true },
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

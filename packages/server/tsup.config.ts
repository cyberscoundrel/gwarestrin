import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // workspace source package ships TS only; must be bundled
  noExternal: ["@gwarestrin/shared"],
});

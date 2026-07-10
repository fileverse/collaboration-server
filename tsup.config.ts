import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cron/publishReconcile.ts"],
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  platform: "node",
  clean: true,
  sourcemap: false,
  dts: false,
});

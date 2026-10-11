import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  .version as string;

export default defineConfig({
  entry: ["src/tagreel-player.ts", "src/slideshow/tagreel-slideshow.ts"],
  format: ["esm", "cjs", "iife"],
  globalName: "TagreelPlayer",
  noExternal: ["@tagreel/core"],
  dts: true,
  clean: true,
  minify: true,
  sourcemap: true,
  define: {
    __TAGREEL_RUNTIME_CDN_URL__: JSON.stringify(
      `https://cdn.jsdelivr.net/npm/@tagreel/core@${packageVersion}/dist/tagreel.runtime.iife.js`,
    ),
  },
});

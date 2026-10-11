import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath (not URL.pathname): on Windows .pathname yields "/D:/..." with a
// leading slash, which breaks resolve() and the alias below.
const coreRoot = resolve(fileURLToPath(new URL("../core/src", import.meta.url)));

export default defineConfig({
  resolve: {
    alias: {
      "@tagreel/core/composition-contract": resolve(coreRoot, "compositionContract.ts"),
      "@tagreel/parsers/composition-contract": resolve(
        coreRoot,
        "../../parsers/src/compositionContract.ts",
      ),
      "@tagreel/core/slideshow": resolve(coreRoot, "slideshow/index.ts"),
      "@tagreel/core/runtime/protocol": resolve(coreRoot, "runtime/protocol.ts"),
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/slideshow/test-setup.ts"],
  },
});

#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expected = `@tagreel/core@${version}/dist/tagreel.runtime.iife.js`;
const bundles = [
  "dist/tagreel-player.js",
  "dist/tagreel-player.cjs",
  "dist/tagreel-player.global.js",
];

for (const bundle of bundles) {
  const source = readFileSync(join(root, bundle), "utf8");
  if (!source.includes(expected)) {
    throw new Error(`${bundle} does not pin the injected runtime to ${version}`);
  }
  if (source.includes("@tagreel/core/dist/tagreel.runtime.iife.js")) {
    throw new Error(`${bundle} still contains an unversioned runtime URL`);
  }
}

console.log(`Verified Player runtime injection is pinned to @tagreel/core@${version}.`);

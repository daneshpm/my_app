import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFromDir } from "./env.mjs";

test("loadEnvFromDir skips a .env folder and loads the .env file above it", () => {
  const root = mkdtempSync(join(tmpdir(), "media-env-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".env"), { recursive: true });
  writeFileSync(join(root, ".env"), "MEDIA_USE_ENV_DIR_TEST=from-parent\n");
  try {
    loadEnvFromDir(project);
    assert.equal(process.env.MEDIA_USE_ENV_DIR_TEST, "from-parent");
  } finally {
    delete process.env.MEDIA_USE_ENV_DIR_TEST;
    rmSync(root, { recursive: true, force: true });
  }
});

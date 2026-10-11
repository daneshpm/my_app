import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { appendRecord, findByPrompt, readManifest } from "./lib/manifest.mjs";
import { regenerateIndex } from "./lib/index-gen.mjs";
import { getProvider } from "./lib/providers.mjs";
import { freezeLocalFile } from "./lib/freeze.mjs";
import { cachePut, cacheGet, importFromCache } from "./lib/cache.mjs";
import { validateCubeFile } from "./lib/cube-validate.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const RESOLVE_CLI = join(import.meta.dirname, "resolve.mjs");
// The "Test: skills" CI job has no ffmpeg on PATH (by design). The smart-grade
// test shells to ffmpeg, so it's skipped there and runs where ffmpeg exists.
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
// The core-conformance test imports core's TypeScript via tsx. The dependency-free
// "Test: skills" CI job has neither tsx nor installed deps, so skip it there; it
// runs wherever the workspace is installed (locally, the main Test job).
const CAN_TSX =
  spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "0"], {
    stdio: "ignore",
  }).status === 0;
process.env.HYPERFRAMES_MEDIA_HOME = mkdtempSync(join(tmpdir(), "mu-resolve-home-"));

let tmp;

function setup() {
  tmp = mkdtempSync(join(tmpdir(), "mu-resolve-test-"));
  // A fresh global cache per test, apart from the project so the two manifests never coincide.
  process.env.HYPERFRAMES_MEDIA_HOME = mkdtempSync(join(tmpdir(), "mu-resolve-home-"));
}

function cleanup() {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

function makeRecord(overrides = {}) {
  return {
    id: "bgm_001",
    type: "bgm",
    path: ".media/audio/bgm/bgm_001.wav",
    source: "search",
    description: "soft minimal ambient",
    duration: 11,
    provenance: { provider: "test", prompt: "test prompt" },
    ...overrides,
  };
}

// Run resolve.mjs with argv passed as a literal array (no shell). Each token is
// a separate argv entry, so a value with spaces or shell metacharacters can't
// break out — never build a command string and hand it to a shell.
function runResolve(args, opts = {}) {
  const { env, ...rest } = opts;
  return execFileSync(process.execPath, [RESOLVE_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, DO_NOT_TRACK: "1", ...env },
    ...rest,
  });
}

function spawnResolve(args, opts = {}) {
  const { env, ...rest } = opts;
  return spawnSync(process.execPath, [RESOLVE_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, DO_NOT_TRACK: "1", ...env },
    ...rest,
  });
}

function makeFrame(dir, name, color) {
  const out = join(dir, name);
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=64x64`,
      "-frames:v",
      "1",
      "-y",
      out,
    ],
    { stdio: "pipe" },
  );
  return out;
}

function normalizeWithCoreSource(grading) {
  const sourcePath = join(REPO_ROOT, "packages/core/src/colorGrading.ts");
  const code = `
    import { normalizeHfColorGrading } from ${JSON.stringify(sourcePath)};
    const grading = JSON.parse(process.env.HF_GRADING_JSON);
    const normalized = normalizeHfColorGrading(grading);
    if (!normalized) process.exit(2);
    console.log(JSON.stringify({
      preset: normalized.preset,
      intensity: normalized.intensity,
      adjust: normalized.adjust,
      lut: normalized.lut,
      colorSpace: normalized.colorSpace
    }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, HF_GRADING_JSON: JSON.stringify(grading) },
    }),
  );
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// --- manifest cache hit ---

test("bundled SFX resolve with an empty PATH", () => {
  setup();
  const result = spawnResolve(["--type", "sfx", "--intent", "whoosh", "--project", tmp, "--json"], {
    env: { HOME: tmp, PATH: tmp },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.provenance.provider, "bundled.sfx");
  assert.equal(parsed.advisory, undefined);
  assert.ok(existsSync(join(tmp, parsed.path)));
  cleanup();
});

test("missing bundled SFX install returns a typed recovery command", () => {
  setup();
  const missingLibrary = join(tmp, "missing-sfx-library");
  const result = spawnResolve(
    ["--type", "sfx", "--intent", "whoosh", "--project", tmp, "--local-only", "--json"],
    {
      env: {
        HOME: tmp,
        PATH: tmp,
        HYPERFRAMES_MEDIA_USE_SFX_DIR: missingLibrary,
      },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "bundled_sfx_assets_missing");
  assert.equal(parsed.fix, "npx hyperframes skills update media-use");
  assert.match(parsed.error, /bundled SFX assets are missing or incomplete/);
  assert.match(parsed.error, /manifest not found/);
  cleanup();
});

test("explicit local bundled SFX resolution does not advise installation", () => {
  for (const extraArgs of [["--local-only"], ["--provider", "bundled.sfx"]]) {
    setup();
    const result = spawnResolve(
      ["--type", "sfx", "--intent", "whoosh", "--project", tmp, "--json", ...extraArgs],
      { env: { HOME: tmp, PATH: tmp } },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.provenance.provider, "bundled.sfx");
    assert.equal(parsed.advisory, undefined);
    cleanup();
  }
});

test("project manifest hit skips providers", () => {
  setup();
  const record = makeRecord({ provenance: { prompt: "cached query", provider: "test" } });
  appendRecord(tmp, record);
  const filePath = join(tmp, record.path);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, "cached audio");

  const out = runResolve(["--type", "bgm", "--intent", "cached query", "--project", tmp, "--json"]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.id, "bgm_001");
  assert.equal(parsed._source, "cached");
  cleanup();
});

test("entity hit matches across icon/image (figma-imported brand marks)", () => {
  setup();
  const record = makeRecord({
    id: "image_001",
    type: "image",
    path: ".media/images/image_001.svg",
    description: "Acme logo",
    entity: "Acme logo",
    provenance: { source: "figma", fileKey: "KEY", nodeId: "1:2", version: "1", format: "svg" },
  });
  delete record.duration;
  appendRecord(tmp, record);
  const filePath = join(tmp, record.path);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, "<svg/>");

  const out = runResolve([
    "--type",
    "icon",
    "--intent",
    "acme brand mark",
    "--entity",
    "Acme logo",
    "--project",
    tmp,
    "--json",
  ]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.id, "image_001");
  assert.equal(parsed._source, "cached");
  cleanup();
});

// --- global cache hit ---

test("global cache hit copies to project and registers", () => {
  setup();
  const sourceFile = join(tmp, "source.wav");
  writeFileSync(sourceFile, "cached globally for resolve");
  const record = makeRecord({ provenance: { prompt: "global resolve test" } });
  cachePut(sourceFile, record);

  const cached = cacheGet("global resolve test", "bgm");
  assert.ok(cached);

  const projectDir = mkdtempSync(join(tmpdir(), "mu-resolve-proj-"));
  const imported = importFromCache(cached, projectDir, "bgm_001", ".media/audio/bgm/bgm_001.wav");
  assert.ok(imported);
  assert.ok(existsSync(join(projectDir, ".media/audio/bgm/bgm_001.wav")));

  appendRecord(projectDir, imported);
  regenerateIndex(projectDir);
  const manifest = readManifest(projectDir);
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].provenance.imported_from, cached.sha);

  rmSync(projectDir, { recursive: true, force: true });
  cleanup();
});

// --- provider interface ---

test("getProvider returns provider with type", () => {
  const p = getProvider("sfx");
  assert.equal(p.type, "sfx");
  assert.ok(typeof p.search === "function");
});

test("getProvider throws for unknown type", () => {
  assert.throws(() => getProvider("unknown_type"), /unknown media type/);
});

// --- freeze ---

test("freezeLocalFile creates parent dirs and copies", () => {
  setup();
  const src = join(tmp, "src.bin");
  writeFileSync(src, "freeze test data");
  const dest = join(tmp, "deep/nested/dir/file.bin");
  freezeLocalFile(src, dest);
  assert.ok(existsSync(dest));
  assert.equal(readFileSync(dest, "utf8"), "freeze test data");
  cleanup();
});

test("failed URL ingest removes its reserved placeholder", () => {
  setup();
  const result = spawnResolve([
    "--from",
    "https://example.invalid/unavailable.jpg",
    "--type",
    "image",
    "--project",
    tmp,
    "--json",
  ]);

  assert.equal(result.status, 1, result.stderr);
  assert.deepStrictEqual(readdirSync(join(tmp, ".media/images")), []);
  assert.deepStrictEqual(readManifest(tmp), []);
  cleanup();
});

// --- adopt existing assets ---

test("--adopt registers existing assets/ files", () => {
  setup();
  mkdirSync(join(tmp, "assets/bgm"), { recursive: true });
  mkdirSync(join(tmp, "assets/icons"), { recursive: true });
  writeFileSync(join(tmp, "assets/bgm/track.mp3"), "fake mp3");
  writeFileSync(join(tmp, "assets/icons/logo.svg"), "fake svg");

  const out = runResolve(["--adopt", "--project", tmp, "--json"]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.adopted, 2);
  assert.ok(parsed.assets.some((a) => a.path === "assets/bgm/track.mp3"));
  assert.ok(parsed.assets.some((a) => a.path === "assets/icons/logo.svg"));

  const manifest = readManifest(tmp);
  assert.equal(manifest.length, 2);
  cleanup();
});

test("--adopt stops, adopting nothing, when HYPERFRAMES_FFPROBE_PATH cannot run", () => {
  setup();
  mkdirSync(join(tmp, "assets/bgm"), { recursive: true });
  writeFileSync(join(tmp, "assets/bgm/track.mp3"), "fake mp3");

  const result = spawnResolve(["--adopt", "--project", tmp, "--json"], {
    env: { HYPERFRAMES_FFPROBE_PATH: join(tmp, "no-ffprobe") },
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.ok, false);
  assert.match(report.error, /HYPERFRAMES_FFPROBE_PATH names .*no-ffprobe.*fix it or unset it/);
  assert.equal(readManifest(tmp).length, 0);
  cleanup();
});

test("--adopt skips already-registered assets", () => {
  setup();
  mkdirSync(join(tmp, "assets/bgm"), { recursive: true });
  writeFileSync(join(tmp, "assets/bgm/track.mp3"), "fake mp3");

  runResolve(["--adopt", "--project", tmp, "--json"]);
  const out = runResolve(["--adopt", "--project", tmp, "--json"]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.adopted, 0);

  const manifest = readManifest(tmp);
  assert.equal(manifest.length, 1);
  cleanup();
});

test("resolve finds existing unregistered asset before hitting providers", () => {
  setup();
  mkdirSync(join(tmp, "assets/bgm"), { recursive: true });
  writeFileSync(join(tmp, "assets/bgm/ambient-track.mp3"), "existing bgm");

  const out = runResolve([
    "--type",
    "bgm",
    "--intent",
    "ambient track",
    "--project",
    tmp,
    "--json",
  ]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.path, "assets/bgm/ambient-track.mp3");
  assert.equal(parsed._source, "existing");
  cleanup();
});

test("--from records a file already in the project where it is, with how it was made", () => {
  setup();
  mkdirSync(join(tmp, "assets/voice"), { recursive: true });
  writeFileSync(join(tmp, "assets/voice/01.wav"), "fake wav");

  const out = runResolve([
    "--from",
    join(tmp, "assets/voice/01.wav"),
    "--type",
    "voice",
    "--source",
    "generated",
    "--intent",
    "Welcome to the launch",
    "--project",
    tmp,
    "--json",
  ]);

  assert.equal(JSON.parse(out.trim()).path, "assets/voice/01.wav");
  assert.deepEqual(
    readManifest(tmp).map((r) => [r.path, r.source, r.description]),
    [["assets/voice/01.wav", "generated", "Welcome to the launch"]],
  );
  assert.deepEqual(readdirSync(join(tmp, ".media/audio/voice")), []);
  cleanup();
});

test("--from --source adds a record only when what it says changes", () => {
  setup();
  mkdirSync(join(tmp, "assets/bgm"), { recursive: true });
  writeFileSync(join(tmp, "assets/bgm/track.mp3"), "fake mp3");
  const from = join(tmp, "assets/bgm/track.mp3");
  const record = (intent) =>
    runResolve([
      ...["--from", from, "--type", "bgm", "--source", "search", "--intent", intent],
      ...["--project", tmp, "--json"],
    ]);

  record("calm underscore");
  record("calm underscore");
  record("upbeat synth");

  assert.deepEqual(
    readManifest(tmp).map((r) => [r.source, r.description]),
    [
      ["search", "calm underscore"],
      ["search", "upbeat synth"],
    ],
  );
  assert.equal(findByPrompt(tmp, "calm underscore", "bgm"), null);
  const listed = runResolve([
    ...["--candidates", "--type", "bgm", "--intent", "calm underscore"],
    ...["--project", tmp, "--json"],
  ]);
  assert.deepEqual(
    JSON.parse(listed)
      .candidates.filter((c) => c.scope === "project")
      .map((c) => c.description),
    ["upbeat synth"],
  );
  const index = readFileSync(join(tmp, ".media/index.md"), "utf8");
  assert.match(index, /upbeat synth/);
  assert.doesNotMatch(index, /calm underscore/);
  cleanup();
});

test("--from refuses a source it does not know", () => {
  setup();
  mkdirSync(join(tmp, "assets/voice"), { recursive: true });
  writeFileSync(join(tmp, "assets/voice/01.wav"), "fake wav");
  const from = join(tmp, "assets/voice/01.wav");

  const r = spawnResolve(["--from", from, "--type", "voice", "--source", "mine", "--project", tmp]);

  assert.equal(r.status, 2);
  assert.deepEqual(readManifest(tmp), []);
  cleanup();
});

test("resolve does not relabel a recorded file in assets/ as the person's own", () => {
  setup();
  mkdirSync(join(tmp, "assets/bgm"), { recursive: true });
  writeFileSync(join(tmp, "assets/bgm/ambient-track.mp3"), "agent bgm");
  appendRecord(tmp, {
    id: "bgm_001",
    type: "bgm",
    path: "assets/bgm/ambient-track.mp3",
    source: "existing",
    description: "ambient track",
    provenance: { provider: "local", adopted: true },
  });
  appendRecord(tmp, {
    id: "bgm_002",
    type: "bgm",
    path: "assets/bgm/ambient-track.mp3",
    source: "search",
    description: "calm underscore",
    provenance: { provider: "test" },
  });

  const out = runResolve([
    "--type",
    "bgm",
    "--intent",
    "ambient track",
    "--project",
    tmp,
    "--json",
  ]);

  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.path, "assets/bgm/ambient-track.mp3");
  assert.equal(parsed.source, "search");
  assert.deepEqual(
    readManifest(tmp).map((r) => r.source),
    ["existing", "search"],
  );
  cleanup();
});

test("--from --source copies a file from outside the project, labelled with that source", () => {
  setup();
  const outside = mkdtempSync(join(tmpdir(), "mu-outside-"));
  writeFileSync(join(outside, "take.wav"), "outside wav");
  const args = ["--from", join(outside, "take.wav"), "--type", "voice", "--source", "generated"];

  const out = runResolve([...args, "--project", tmp, "--json"]);

  const parsed = JSON.parse(out.trim());
  assert.match(parsed.path, /^\.media\/audio\/voice\//);
  assert.equal(parsed.source, "generated");
  rmSync(outside, { recursive: true, force: true });
  cleanup();
});

test("--source is refused for a LUT and without --from", () => {
  setup();
  writeFileSync(join(tmp, "look.cube"), "LUT_3D_SIZE 2\n");
  const lut = ["--from", join(tmp, "look.cube"), "--type", "lut", "--source", "generated"];

  assert.equal(spawnResolve([...lut, "--project", tmp]).status, 2);
  assert.equal(spawnResolve(["--source", "generated", "--project", tmp]).status, 2);
  assert.deepEqual(readManifest(tmp), []);
  cleanup();
});

// --- CLI interface ---

test("--help exits 0", () => {
  const out = runResolve(["--help"]);
  assert.ok(out.includes("media-use resolve"));
  assert.ok(out.includes("--type"));
  assert.ok(out.includes("--for"));
  assert.ok(out.includes("--analyze"));
  assert.ok(out.includes("--from"));
  assert.ok(out.includes("--local-only"));
  assert.ok(out.includes("--stats"));
});

test("--from registers a derived video as documented", () => {
  setup();
  const source = join(tmp, "derived.mp4");
  writeFileSync(source, "derived video bytes");

  const out = runResolve(["--from", source, "--type", "video", "--project", tmp, "--json"]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, "video");
  assert.match(parsed.path, /^\.media\/video\/video_001\.mp4$/);
  assert.equal(readManifest(tmp)[0]?.type, "video");
  cleanup();
});

test("--from type error lists video exactly once", () => {
  const result = spawnResolve(["--from", "missing.mp4"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--from requires --type \(one of:/);
  assert.equal(result.stderr.match(/\bvideo\b/g)?.length, 1);
});

test("--from uses .mp4 as the default video extension", () => {
  setup();
  const source = join(tmp, "extensionless-video");
  writeFileSync(source, "video bytes");

  const out = runResolve(["--from", source, "--type", "video", "--project", tmp, "--json"]);
  const parsed = JSON.parse(out.trim());
  assert.match(parsed.path, /^\.media\/video\/video_001\.mp4$/);
  cleanup();
});

test("unknown type error lists grade and lut", () => {
  try {
    runResolve(["--type", "bogus", "--intent", "x"], { stdio: "pipe" });
    assert.fail("should have exited");
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /known: .*grade.*lut/);
  }
});

test("missing required args exits 2", () => {
  try {
    runResolve([], { stdio: "pipe" });
    assert.fail("should have exited");
  } catch (err) {
    assert.equal(err.status, 2);
  }
});

test("--json returns error JSON on stub provider failure", () => {
  setup();
  try {
    runResolve(["--type", "bgm", "--intent", "stub fail", "--project", tmp, "--json"], {
      stdio: "pipe",
    });
    assert.fail("should have exited");
  } catch (err) {
    const output = err.stdout || "";
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error.includes("no catalog provider for bgm"));
  }
  cleanup();
});

test("--doctor --json reports dependency checks and top-level ok requires ffmpeg and ffprobe", () => {
  const result = spawnResolve(["--doctor", "--json"]);
  assert.match(result.stdout.trim(), /^\{/);
  assert.equal(result.stderr, "");
  assert.ok(result.status === 0 || result.status === 1);

  const parsed = JSON.parse(result.stdout.trim());
  assert.ok(Array.isArray(parsed.checks));

  const expected = ["bundled SFX assets", "ffmpeg on PATH", "ffprobe on PATH", "node version"];
  const byName = new Map(parsed.checks.map((check) => [check.name, check]));
  for (const name of expected) {
    assert.ok(byName.has(name), `missing check: ${name}`);
    const check = byName.get(name);
    assert.equal(typeof check.ok, "boolean", `${name}.ok`);
    assert.equal(typeof check.detail, "string", `${name}.detail`);
    assert.ok("fix" in check, `${name}.fix`);
  }

  const ffmpeg = byName.get("ffmpeg on PATH");
  const ffprobe = byName.get("ffprobe on PATH");
  const bundledSfx = byName.get("bundled SFX assets");
  assert.match(bundledSfx.detail, /bundled SFX assets available/);
  const strictOk = bundledSfx.ok && ffmpeg.ok && ffprobe.ok;
  assert.equal(parsed.ok, strictOk);
  assert.equal(result.status, strictOk ? 0 : 1);
});

test("--doctor checks the ffmpeg and ffprobe that HYPERFRAMES_FFMPEG_PATH and HYPERFRAMES_FFPROBE_PATH name", () => {
  const dir = mkdtempSync(join(tmpdir(), "mu-doctor-ff-"));
  for (const tool of ["ffmpeg", "ffprobe"]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\necho '${tool} version 9.9-fake'\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  try {
    const result = spawnResolve(["--doctor", "--json"], {
      env: {
        HYPERFRAMES_FFMPEG_PATH: join(dir, "ffmpeg"),
        HYPERFRAMES_FFPROBE_PATH: join(dir, "ffprobe"),
      },
    });
    const byName = new Map(JSON.parse(result.stdout.trim()).checks.map((c) => [c.name, c]));
    for (const tool of ["ffmpeg", "ffprobe"])
      assert.deepEqual(
        [byName.get(`${tool} on PATH`).ok, byName.get(`${tool} on PATH`).detail],
        [true, `${tool} version 9.9-fake`],
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--doctor fails a HYPERFRAMES_FFPROBE_PATH that cannot run and says to fix or unset it", () => {
  const missing = join(tmpdir(), "mu-doctor-no-ffprobe", "ffprobe");
  const result = spawnResolve(["--doctor", "--json"], {
    env: { HYPERFRAMES_FFPROBE_PATH: missing },
  });
  const report = JSON.parse(result.stdout.trim());
  const check = report.checks.find((c) => c.name === "ffprobe on PATH");
  assert.equal(report.ok, false);
  assert.deepEqual(
    [check.ok, check.detail, check.fix],
    [
      false,
      `HYPERFRAMES_FFPROBE_PATH names "${missing}", which is not a working ffprobe: fix it or unset it.`,
      "fix or unset that variable",
    ],
  );
});

test("--analyze refuses a HYPERFRAMES_FFPROBE_PATH that cannot run instead of reporting unknown", () => {
  const missing = join(tmpdir(), "mu-analyze-no-ffprobe", "ffprobe");
  const result = spawnResolve(["--analyze", "--type", "grade", "--for", RESOLVE_CLI, "--json"], {
    env: { HYPERFRAMES_FFPROBE_PATH: missing },
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.ok, false);
  assert.match(
    report.error,
    /HYPERFRAMES_FFPROBE_PATH names ".*mu-analyze-no-ffprobe.*fix it or unset it/,
  );
});

test("--doctor fails a configured ffprobe that exists but exits with an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "mu-doctor-bad-ff-"));
  const broken = join(dir, "ffprobe");
  writeFileSync(broken, "#!/bin/sh\nexit 3\n");
  chmodSync(broken, 0o755);
  try {
    const result = spawnResolve(["--doctor", "--json"], {
      env: { HYPERFRAMES_FFPROBE_PATH: broken },
    });
    const check = JSON.parse(result.stdout.trim()).checks.find((c) => c.name === "ffprobe on PATH");
    assert.deepEqual(
      [check.ok, check.detail, check.fix],
      [
        false,
        `HYPERFRAMES_FFPROBE_PATH names "${broken}", which is not a working ffprobe: fix it or unset it.`,
        "fix or unset that variable",
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken HYPERFRAMES_FFPROBE_PATH is named when local voice cannot run, not a generic miss", () => {
  setup();
  const missing = join(tmp, "no-ffprobe");
  const result = spawnResolve(
    [
      "--type",
      "voice",
      "--intent",
      "hello",
      "--provider",
      "kokoro.local",
      "--project",
      tmp,
      "--json",
    ],
    { env: { HYPERFRAMES_FFPROBE_PATH: missing } },
  );
  assert.equal(result.status, 1);
  assert.equal(
    JSON.parse(result.stdout.trim()).error,
    `HYPERFRAMES_FFPROBE_PATH names "${missing}", which is not a working ffprobe: fix it or unset it.`,
  );
  cleanup();
});

test("one-line output format matches contract", () => {
  setup();
  const record = makeRecord({ provenance: { prompt: "format test", provider: "test" } });
  appendRecord(tmp, record);
  const filePath = join(tmp, record.path);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, "format check");

  const out = runResolve(["--type", "bgm", "--intent", "format test", "--project", tmp]);
  assert.match(out.trim(), /^resolved bgm_001 → .media\/audio\/bgm\/bgm_001\.wav \(bgm/);
  cleanup();
});

// --- color grading ---

test("grade resolves a preset-only look with no cube file", () => {
  setup();
  const out = runResolve([
    "--type",
    "grade",
    "--intent",
    "warm daylight",
    "--project",
    tmp,
    "--json",
  ]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, "grade");
  assert.equal(parsed.grading.preset, "warm-daylight");
  assert.equal(parsed.grading.lut, undefined);
  assert.equal(parsed.path, undefined);
  assert.equal(readManifest(tmp).length, 1);
  cleanup();
});

test("grade resolves a library LUT look and freezes a validated cube", () => {
  setup();
  const out = runResolve([
    "--type",
    "grade",
    "--intent",
    "teal orange blockbuster",
    "--project",
    tmp,
    "--json",
  ]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.match(parsed.grading.lut.src, /^\.media\/luts\/grade_001\.cube$/);
  assert.equal(parsed.path, parsed.grading.lut.src);
  assert.ok(existsSync(join(tmp, parsed.grading.lut.src)));
  assert.equal(validateCubeFile(join(tmp, parsed.grading.lut.src)).ok, true);
  cleanup();
});

test("smart grade merges measured adjust and keeps stdout valid JSON", () => {
  if (!HAS_FFMPEG) {
    console.log("  (skipped: ffmpeg not on PATH)");
    return;
  }
  setup();
  const frame = makeFrame(tmp, "under.png", "0x202020");
  const proc = spawnResolve([
    "--type",
    "grade",
    "--intent",
    "warm cinematic",
    "--for",
    frame,
    "--project",
    tmp,
    "--json",
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.grading.adjust.exposure > 0, "under-exposed frame should suggest lift");
  assert.match(proc.stderr, /media-use: measured/);
  cleanup();
});

test("grade analysis returns evidence without recording a candidate", () => {
  if (!HAS_FFMPEG) {
    console.log("  (skipped: ffmpeg not on PATH)");
    return;
  }
  setup();
  const frame = makeFrame(tmp, "under.png", "0x202020");
  const proc = spawnResolve([
    "--type",
    "grade",
    "--for",
    frame,
    "--analyze",
    "--project",
    tmp,
    "--json",
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, "grade-analysis");
  assert.ok(parsed.adjust.exposure > 0, "under-exposed frame should suggest lift");
  assert.ok(parsed.measured.frames > 0);
  assert.equal(readManifest(tmp).length, 0);
  cleanup();
});

test("emitted grading block survives the core normalizeHfColorGrading contract", () => {
  if (!CAN_TSX) {
    console.log("  (skipped: tsx / core source unavailable)");
    return;
  }
  setup();
  const out = runResolve([
    "--type",
    "grade",
    "--intent",
    "teal orange blockbuster",
    "--project",
    tmp,
    "--json",
  ]);
  const parsed = JSON.parse(out.trim());
  const normalized = normalizeWithCoreSource(parsed.grading);
  assert.equal(normalized.lut.src, parsed.grading.lut.src);
  assert.equal(normalized.lut.intensity, parsed.grading.lut.intensity);
  assert.equal(normalized.colorSpace, "rec709");
  cleanup();
});

test("lut resolves only the frozen cube path", () => {
  setup();
  const out = runResolve([
    "--type",
    "lut",
    "--intent",
    "teal orange blockbuster",
    "--project",
    tmp,
    "--json",
  ]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, "lut");
  assert.match(parsed.path, /^\.media\/luts\/lut_001\.cube$/);
  assert.equal(parsed.grading, undefined);
  assert.equal(validateCubeFile(join(tmp, parsed.path)).ok, true);
  cleanup();
});

test("lut --params builds, validates, and freezes a cube", () => {
  setup();
  const params = { contrast: 0.2, temperature: -0.3 };
  const out = runResolve(["-t", "lut", "--params", JSON.stringify(params), "-p", tmp, "--json"]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, "lut");
  assert.match(parsed.path, /^\.media\/luts\/lut_001\.cube$/);
  assert.equal(parsed.description, "custom parametric lut");
  assert.equal(parsed.provenance.provider, "cube_lut.builder");
  assert.deepEqual(parsed.provenance.params, params);
  assert.ok(existsSync(join(tmp, parsed.path)));
  assert.equal(validateCubeFile(join(tmp, parsed.path)).ok, true);
  cleanup();
});

test("grade --params returns a grading block with a frozen valid cube", () => {
  setup();
  const out = runResolve([
    "-t",
    "grade",
    "--params",
    JSON.stringify({ exposure: 0.2 }),
    "-p",
    tmp,
    "--json",
  ]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, "grade");
  assert.equal(parsed.grading.intensity, 1);
  assert.match(parsed.grading.lut.src, /^\.media\/luts\/grade_001\.cube$/);
  assert.equal(parsed.lut.src, parsed.grading.lut.src);
  assert.equal(parsed.path, parsed.grading.lut.src);
  assert.equal(validateCubeFile(join(tmp, parsed.grading.lut.src)).ok, true);
  cleanup();
});

test("--params malformed JSON errors cleanly without freezing a cube", () => {
  setup();
  const proc = spawnResolve(["-t", "lut", "--params", "{not json", "-p", tmp, "--json"]);
  assert.equal(proc.status, 1, proc.stderr);
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /^invalid --params JSON:/);
  assert.equal(readManifest(tmp).length, 0);
  assert.equal(existsSync(join(tmp, ".media/luts")), false);
  cleanup();
});

// buildCube clamps every accepted parameter and resolve.mjs does not expose
// the size argument, so there is no CLI input that can make --params emit a
// structurally invalid cube. Invalid cube cleanup is covered through --from.
test("--from rejects invalid lut cube without registering or leaving a frozen file", () => {
  setup();
  const broken = join(tmp, "broken.cube");
  writeFileSync(broken, "LUT_3D_SIZE 999\n");
  const proc = spawnResolve(["--from", broken, "-t", "lut", "-p", tmp, "--json"]);
  assert.equal(proc.status, 1, proc.stderr);
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /^ingested LUT is invalid: LUT_3D_SIZE 999 exceeds max 64/);
  assert.equal(readManifest(tmp).length, 0);
  const lutDir = join(tmp, ".media/luts");
  assert.deepEqual(existsSync(lutDir) ? readdirSync(lutDir) : [], []);
  cleanup();
});

test("grade miss exits explicitly with no partial file", () => {
  setup();
  const missIntent = `zqxv imaginary neutron ${process.pid}`;
  try {
    runResolve(["--type", "grade", "--intent", missIntent, "--project", tmp, "--json"]);
    assert.fail("should have exited");
  } catch (err) {
    assert.equal(err.status, 1);
    const parsed = JSON.parse(String(err.stdout));
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /no local color grade could resolve/);
    assert.equal(readManifest(tmp).length, 0);
    assert.equal(existsSync(join(tmp, ".media/luts")), false);
  }
  cleanup();
});

test("identical grade resolve hits the project cache without re-freezing", () => {
  setup();
  const first = JSON.parse(
    runResolve([
      "--type",
      "grade",
      "--intent",
      "teal orange blockbuster",
      "--project",
      tmp,
      "--json",
    ]),
  );
  const second = JSON.parse(
    runResolve([
      "--type",
      "grade",
      "--intent",
      "teal orange blockbuster",
      "--project",
      tmp,
      "--json",
    ]),
  );
  assert.equal(second._source, "cached");
  assert.equal(second.id, first.id);
  assert.equal(second.path, first.path);
  assert.equal(readManifest(tmp).length, 1);
  cleanup();
});

// --- telemetry removal ---

test("track() is a no-op: it never touches the network", async () => {
  const { track } = await import("./lib/telemetry.mjs");
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("{}");
  };
  try {
    await track("media_use_resolve", { type: "bgm", provider: "test" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0, "track() must not call fetch");
});

// --- run ---

async function main() {
  console.log("media-use · resolve engine tests\n");
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`    ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

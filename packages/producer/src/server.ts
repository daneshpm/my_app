#!/usr/bin/env node
/**
 * @hyperframes/producer — Public Server
 *
 * Clean HTTP API for rendering HTML compositions to video.
 *
 * Routes:
 *   POST /render         — blocking render, returns JSON
 *   POST /render/stream  — SSE streaming render with progress
 *   GET  /render/queue   — current render queue status
 *   POST /lint           — blocking Hyperframe lint
 *   GET  /health         — health check
 *   GET  /outputs/:token — download rendered MP4
 *
 * Auth (optional): set PRODUCER_AUTH_TOKEN to require
 * `Authorization: Bearer <token>` on every route except /health (401 otherwise).
 * Unset = no auth, so keep the default loopback bind or a trusted network.
 *
 * Restrict external assets: PRODUCER_RESTRICT_EXTERNAL_ASSETS=1|0 (see
 * shouldRestrictExternalAssets for the default).
 */

import {
  existsSync,
  mkdirSync,
  statSync,
  realpathSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  createReadStream,
} from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import { tmpdir } from "node:os";
import type { Server as HttpServer } from "node:http";
import { parseArgs } from "node:util";
import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
  RenderCancelledError,
  createRenderJob,
  executeRenderJob,
  type ProgressCallback,
  type RenderConfig,
  type RenderJob,
} from "./services/renderOrchestrator.js";
import { prepareHyperframeLintBody, runHyperframeLint } from "./services/hyperframeLint.js";
import { startHealthWorker, type HealthWorkerHandle } from "./services/healthWorker.js";
import {
  drainBrowserPool,
  fetchPublicHttpsText,
  isVideoFrameFormat,
  killTrackedProcesses,
} from "@hyperframes/engine";
import { isPathInside, resolveRenderPaths } from "./utils/paths.js";
import { defaultLogger, type ProducerLogger } from "./logger.js";
import { Semaphore } from "./utils/semaphore.js";
import {
  parseFps,
  normalizeResolutionFlag,
  isAspectAgnosticResolutionAlias,
  type CanvasResolution,
} from "@hyperframes/core";
import { createRenderRequest, renderConfigFromRequest } from "./renderRequest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface HandlerOptions {
  /** Custom logger. Defaults to console-based defaultLogger. */
  logger?: ProducerLogger;
  /** Extract or generate a request ID. Defaults to x-request-id header or random UUID. */
  getRequestId?: (c: Context) => string;
  /** Directory for rendered output files. Defaults to PRODUCER_RENDERS_DIR or /tmp. */
  rendersDir?: string;
  /** Prefix for output URLs in responses. Default: "/outputs". */
  outputUrlPrefix?: string;
  /** TTL for output artifact download tokens (ms). Default: 15 minutes. */
  artifactTtlMs?: number;
  /** Max renders that execute simultaneously. Queued requests wait FIFO. Default: 2. */
  maxConcurrentRenders?: number;
  /**
   * Bearer token required on every route except /health (used by
   * createProducerApp / startServer). Defaults to PRODUCER_AUTH_TOKEN; when
   * neither is set, auth is off.
   */
  authToken?: string;
}

export interface ServerOptions extends HandlerOptions {
  /** Port to listen on. Default: 9847. */
  port?: number;
  /**
   * Interface to bind. Default: PRODUCER_HOST, else 127.0.0.1. Auth is off unless
   * PRODUCER_AUTH_TOKEN is set, so when widening this (e.g. "0.0.0.0" in a
   * container) either set a token or stay behind a trusted network.
   */
  hostname?: string;
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------
interface RenderInput {
  projectDir: string;
  outputPath?: string | null;
  fps: import("@hyperframes/core").Fps;
  quality: "draft" | "standard" | "high";
  format?: "mp4" | "webm" | "mov";
  videoFrameFormat?: RenderConfig["videoFrameFormat"];
  outputDynamicRange?: "auto" | "hdr" | "sdr";
  workers?: number;
  useGpu: boolean;
  debug: boolean;
  strictness: RenderConfig["strictness"];
  entryFile?: string;
  /**
   * data-composition-variables overrides forwarded into the render config.
   * Without this the HTTP/server render path silently rendered the
   * composition's declared defaults, ignoring per-request overrides.
   */
  variables?: Record<string, unknown>;
  /**
   * Output resolution preset (e.g. `landscape-4k`). Drives the same
   * `resolveDeviceScaleFactor` supersampling path the local CLI uses — Chrome
   * renders at a higher devicePixelRatio so the captured screenshot lands at
   * the requested dimensions. Aspect ratio must match the composition unless
   * `outputResolutionAspectAgnostic` is set (see below).
   */
  outputResolution?: CanvasResolution;
  /**
   * True when `outputResolution` was normalized from an aspect-agnostic alias
   * (`1080p`, `hd`, `4k`, `uhd`). The compile stage will adapt the preset to
   * the composition's orientation instead of rejecting portrait/square
   * compositions as an aspect-ratio mismatch.
   */
  outputResolutionAspectAgnostic?: boolean;
}

interface PreparedRenderInput {
  input: RenderInput;
  cleanupProjectDir?: string;
}

const DEFAULT_SERVER_FPS = { num: 30, den: 1 } as const;
const SAFE_RENDER_ERROR_CODES = new Set<string>([
  "ASSET_MEDIA_TYPE_MISMATCH",
  "NOT_MEDIA_PAYLOAD",
  "INVALID_VIDEO_METADATA",
  "VIDEO_SOURCE_UNRENDERABLE",
  "VIDEO_EXTRACTION_FAILED",
  "ENCODER_INTERRUPTED",
]);

/**
 * Preserve only bounded producer error codes across JSON/SSE. Never derive a
 * code from the message: it may contain local paths or signed source URLs.
 */
export function extractSafeRenderErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" && SAFE_RENDER_ERROR_CODES.has(code) ? code : undefined;
}

export interface SafeRenderErrorMetadata {
  errorCode: string;
  errorOwner?: "system" | "user";
  retryable?: boolean;
  /** Public, producer-authored data whose schema and policy belong to callers. */
  errorMetadata?: Readonly<Record<string, unknown>>;
}

/**
 * Additive public metadata for typed producer failures. The producer server
 * only transports it; callers own schema validation and policy decisions.
 */
export function extractSafeRenderErrorMetadata(
  error: unknown,
): SafeRenderErrorMetadata | undefined {
  const errorCode = extractSafeRenderErrorCode(error);
  if (!errorCode || typeof error !== "object" || error === null) return undefined;
  const owner = "owner" in error ? error.owner : undefined;
  const retryable = "retryable" in error ? error.retryable : undefined;
  const publicMetadata = "publicMetadata" in error ? error.publicMetadata : undefined;
  return {
    errorCode,
    errorOwner: owner === "user" || owner === "system" ? owner : undefined,
    retryable: typeof retryable === "boolean" ? retryable : undefined,
    ...(isPlainObject(publicMetadata) ? { errorMetadata: publicMetadata } : {}),
  };
}

function parseServerFps(value: unknown): RenderInput["fps"] {
  if (typeof value !== "number" && typeof value !== "string") return DEFAULT_SERVER_FPS;
  const parsed = parseFps(value);
  return parsed.ok ? parsed.value : DEFAULT_SERVER_FPS;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOutputCandidate(body: Record<string, unknown>): string | null {
  return nonEmptyString(body.outputPath) ?? nonEmptyString(body.output) ?? null;
}

function parseServerQuality(value: unknown): RenderInput["quality"] {
  return value === "draft" || value === "standard" || value === "high" ? value : "high";
}

function parseServerFormat(value: unknown): RenderInput["format"] {
  return value === "mp4" || value === "webm" || value === "mov" ? value : undefined;
}

function parseServerOutputDynamicRange(value: unknown): RenderInput["outputDynamicRange"] {
  return value === "auto" || value === "hdr" || value === "sdr" ? value : undefined;
}

function parseLegacyServerHdrMode(value: unknown): RenderConfig["hdrMode"] {
  return value === "auto" || value === "force-hdr" || value === "force-sdr" ? value : undefined;
}

function fromRenderHdrMode(hdrMode: RenderConfig["hdrMode"]): RenderInput["outputDynamicRange"] {
  if (hdrMode === "force-hdr") return "hdr";
  if (hdrMode === "force-sdr") return "sdr";
  return hdrMode;
}

function toRenderHdrMode(
  outputDynamicRange: RenderInput["outputDynamicRange"],
): RenderConfig["hdrMode"] {
  if (outputDynamicRange === "hdr") return "force-hdr";
  if (outputDynamicRange === "sdr") return "force-sdr";
  return outputDynamicRange;
}

export function parseRenderOptions(body: Record<string, unknown>): Omit<RenderInput, "projectDir"> {
  // Accept either a JSON `number` (integer fps) or a JSON `string` (rational
  // like "30000/1001"). Falls back to 30 fps on parse failure to preserve the
  // forgiving behaviour the original whitelist had — the producer surfaces a
  // clearer downstream error if the value is genuinely unusable.
  const fps = parseServerFps(body.fps);
  const quality = parseServerQuality(body.quality);
  const workers = typeof body.workers === "number" ? body.workers : undefined;
  const useGpu = body.gpu === true;
  const debug = body.debug === true;
  // Preserve the pre-structured-warning HTTP contract for callers that do
  // not yet send this field. Strict readiness is an explicit opt-in via
  // `bestEffort: false`; omission must keep producing degraded output with
  // structured warnings while downstream callers migrate.
  const strictness = body.bestEffort === false ? "strict" : "best-effort";
  const outputPath = parseOutputCandidate(body);
  const entryFile = nonEmptyString(body.entryFile);
  const format = parseServerFormat(body.format);
  const outputDynamicRange =
    parseServerOutputDynamicRange(body.outputDynamicRange) ??
    fromRenderHdrMode(parseLegacyServerHdrMode(body.hdrMode));
  const videoFrameFormat = isVideoFrameFormat(body.videoFrameFormat)
    ? body.videoFrameFormat
    : undefined;

  const { variables, outputResolution, outputResolutionAspectAgnostic } =
    parseRenderOverrides(body);

  return {
    outputPath,
    fps,
    quality,
    workers,
    useGpu,
    debug,
    strictness,
    entryFile,
    format,
    outputDynamicRange,
    variables,
    outputResolution,
    outputResolutionAspectAgnostic,
    videoFrameFormat,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the lenient form of the variable + resolution overrides used by
 * `parseRenderOptions`. Invalid shapes coerce to `undefined` here;
 * `validateRenderOverrides` separately rejects explicitly-supplied bad values
 * with a 400 so they aren't silently ignored.
 */
function parseRenderOverrides(body: Record<string, unknown>): {
  variables?: Record<string, unknown>;
  outputResolution?: CanvasResolution;
  outputResolutionAspectAgnostic?: boolean;
} {
  // Only forward a plain JSON object. Arrays / primitives / null → undefined.
  const variables = isPlainObject(body.variables) ? body.variables : undefined;
  // Accept canonical presets and aliases ("4k", "landscape-4k", …).
  const rawOutputResolution =
    typeof body.outputResolution === "string" ? body.outputResolution : undefined;
  const outputResolution = rawOutputResolution
    ? normalizeResolutionFlag(rawOutputResolution)
    : undefined;
  // Preserve the "raw shape was tier-only" signal so the compile stage can
  // adapt the preset to the composition's orientation. Set only when
  // normalization succeeded — a bad string doesn't need the flag.
  const outputResolutionAspectAgnostic = outputResolution
    ? isAspectAgnosticResolutionAlias(rawOutputResolution)
    : undefined;
  return { variables, outputResolution, outputResolutionAspectAgnostic };
}

/**
 * Build the `createRenderJob` config from a prepared render input. Shared by
 * the sync (`render`) and streaming (`render-stream`) handlers so the field
 * set — including `variables` and `outputResolution` — stays in one place.
 */
function buildRenderJobConfig(
  input: RenderInput,
  outputPath: string,
  log: ProducerLogger,
  restrictExternalAssets: boolean,
) {
  const request = createRenderRequest({
    projectDir: input.projectDir,
    outputPath,
    options: {
      fps: input.fps,
      quality: input.quality,
      format: input.format ?? "mp4",
      workers: input.workers,
      useGpu: input.useGpu,
      debug: input.debug,
      strictness: input.strictness,
      entryFile: input.entryFile,
      variables: input.variables,
      outputResolution: input.outputResolution,
      outputResolutionAspectAgnostic: input.outputResolutionAspectAgnostic,
      videoFrameFormat: input.videoFrameFormat,
      hdrMode: toRenderHdrMode(input.outputDynamicRange),
    },
  });
  return { ...renderConfigFromRequest(request, { logger: log }), restrictExternalAssets };
}

/**
 * Whether an HTTP render must refuse assets outside its project directory.
 *
 * PRODUCER_RESTRICT_EXTERNAL_ASSETS=1/true forces it on for every server render,
 * 0/false forces it off. Unset: restricted only for inline/previewUrl HTML (a
 * server-created temp project, where a `../` or absolute path can only be an
 * attempt to read server files); a caller-supplied projectDir keeps the CLI's
 * shared-asset behaviour. The CLI render path never sets this.
 */
export function shouldRestrictExternalAssets(
  inlineProject: boolean,
  envValue: string | undefined = process.env.PRODUCER_RESTRICT_EXTERNAL_ASSETS,
): boolean {
  const v = envValue?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return inlineProject;
}

/**
 * Resolve the destination path for a prepared render and ensure its parent
 * directory exists. Shared by the sync + streaming handlers (their only
 * difference is how a `prepareRenderBody` error is surfaced — JSON vs SSE —
 * which stays in each handler).
 */
function resolvePreparedRenderOutput(
  prepared: PreparedRenderInput,
  rendersDir: string,
  log: ProducerLogger,
): { input: RenderInput; cleanupProjectDir?: string; absoluteOutputPath: string } {
  const { input, cleanupProjectDir } = prepared;
  const absoluteOutputPath = resolveOutputPath(input.projectDir, input.outputPath, rendersDir, log);
  const outputDir = dirname(absoluteOutputPath);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  return { input, cleanupProjectDir, absoluteOutputPath };
}

/**
 * Validate explicitly-supplied render overrides that can't be sanely coerced.
 * Returns an error string for a clean 400, or `undefined` when the body is
 * acceptable (including when the fields are simply absent).
 */
function validateRenderOverrides(body: Record<string, unknown>): string | undefined {
  if (body.variables !== undefined && !isPlainObject(body.variables)) {
    return 'variables must be a JSON object keyed by variable id (e.g. {"title":"Hello"})';
  }
  if (
    body.outputDynamicRange !== undefined &&
    parseServerOutputDynamicRange(body.outputDynamicRange) === undefined
  ) {
    return 'outputDynamicRange must be one of: "auto", "hdr", "sdr"';
  }
  const legacyHdrMode = parseLegacyServerHdrMode(body.hdrMode);
  if (body.hdrMode !== undefined && legacyHdrMode === undefined) {
    return 'legacy hdrMode must be one of: "auto", "force-hdr", "force-sdr"';
  }
  const outputDynamicRange = parseServerOutputDynamicRange(body.outputDynamicRange);
  if (
    outputDynamicRange !== undefined &&
    legacyHdrMode !== undefined &&
    outputDynamicRange !== fromRenderHdrMode(legacyHdrMode)
  ) {
    return "outputDynamicRange and legacy hdrMode must describe the same output policy";
  }
  return validateOutputResolutionOverride(body);
}

/**
 * Validate an explicitly-supplied `outputResolution`. Rejects (a) non-string
 * values, which parseRenderOverrides would otherwise silently coerce to
 * `undefined`; (b) unknown presets; and (c) the alpha-format combination —
 * outputResolution drives deviceScaleFactor supersampling, which the webm/mov
 * capture path can't apply (resolveDeviceScaleFactor throws mid-render), so we
 * reject it here for a clean 400 regardless of which caller sent it.
 */
function validateOutputResolutionOverride(body: Record<string, unknown>): string | undefined {
  if (body.outputResolution === undefined) return undefined;
  if (typeof body.outputResolution !== "string") {
    return 'outputResolution must be a string preset (e.g. "4k", "landscape-4k")';
  }
  const normalized = normalizeResolutionFlag(body.outputResolution);
  if (body.outputResolution.trim().length > 0 && normalized === undefined) {
    return `Invalid outputResolution "${body.outputResolution}". Must be one of: landscape, portrait, landscape-4k, portrait-4k, square, square-4k (aliases: 1080p, 4k, …).`;
  }
  if (normalized !== undefined && (body.format === "webm" || body.format === "mov")) {
    return `outputResolution is not supported with format "${body.format}" — the alpha (webm/mov) capture path can't supersample. Use format "mp4", or omit outputResolution to render at the composition's native dimensions.`;
  }
  return undefined;
}

type PrepareRenderResult = { prepared: PreparedRenderInput } | { error: string };

function prepareProjectDirectory(
  projectDir: unknown,
  options: Omit<RenderInput, "projectDir">,
): PrepareRenderResult | null {
  const candidate = nonEmptyString(projectDir);
  if (!candidate) return null;
  const absProjectDir = resolve(candidate);
  if (!existsSync(absProjectDir) || !statSync(absProjectDir).isDirectory()) {
    return { error: `Project directory not found: ${absProjectDir}` };
  }
  const entry = options.entryFile || "index.html";
  const absEntry = resolve(absProjectDir, entry);
  // entryFile is caller-controlled: keep it inside the project (same rule as /lint).
  if (absEntry === absProjectDir || !isPathInside(absEntry, absProjectDir)) {
    return { error: `Entry file must stay inside project directory: ${entry}` };
  }
  if (!existsSync(absEntry)) {
    return { error: `Entry file "${entry}" not found in project directory: ${absProjectDir}` };
  }
  // A symlink inside the project can still point outside it.
  if (!isPathInside(realpathSync(absEntry), realpathSync(absProjectDir))) {
    return { error: `Entry file must stay inside project directory: ${entry}` };
  }
  return { prepared: { input: { projectDir: absProjectDir, ...options } } };
}

const MAX_PREVIEW_URL_BYTES = 32 * 1024 * 1024;
const PREVIEW_URL_TIMEOUT_MS = 30_000;

async function resolveInlineRenderHtml(body: Record<string, unknown>): Promise<
  | { html: string }
  | {
      error: string;
    }
> {
  const inlineHtml = typeof body.html === "string" ? body.html : "";
  if (inlineHtml) return { html: inlineHtml };
  const previewUrl = nonEmptyString(body.previewUrl);
  if (!previewUrl)
    return { error: "Missing render source: provide projectDir, previewUrl, or html" };
  try {
    // SSRF guard: HTTPS + public hosts only, every redirect hop re-validated, size/time bounded.
    return {
      html: await fetchPublicHttpsText(previewUrl, {
        maxBytes: MAX_PREVIEW_URL_BYTES,
        timeoutMs: PREVIEW_URL_TIMEOUT_MS,
      }),
    };
  } catch (error) {
    return {
      error: `Failed to fetch previewUrl: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Inline-project temp dirs not yet cleaned up; swept on shutdown. */
const pendingTempDirs = new Set<string>();

/** Remove every outstanding inline-project temp dir (used on shutdown). */
export function removePendingTempProjectDirs(): void {
  for (const dir of [...pendingTempDirs]) cleanupTempDir(dir, defaultLogger);
}

function materializeInlineProject(
  html: string,
  options: Omit<RenderInput, "projectDir">,
): PrepareRenderResult {
  const tempRoot = process.env.PRODUCER_TMP_PROJECT_DIR || tmpdir();
  const tempProjectDir = mkdtempSync(join(tempRoot, "producer-project-"));
  pendingTempDirs.add(tempProjectDir);
  writeFileSync(join(tempProjectDir, "index.html"), html, "utf-8");
  return {
    prepared: {
      input: { projectDir: tempProjectDir, ...options },
      cleanupProjectDir: tempProjectDir,
    },
  };
}

export async function prepareRenderBody(
  body: Record<string, unknown>,
  rendersDir?: string,
): Promise<PrepareRenderResult> {
  // Reject explicitly-supplied-but-malformed overrides up front so the caller
  // gets a clear 400 instead of a silently-ignored value.
  const overrideError = validateRenderOverrides(body);
  if (overrideError) return { error: overrideError };

  // ffmpeg runs with `-y`, so an HTTP caller must not pick a destination outside
  // the renders dir (it could overwrite any writable file).
  const requestedOutput = parseOutputCandidate(body);
  if (rendersDir && requestedOutput && !isPathInside(requestedOutput, rendersDir)) {
    return { error: "outputPath must be inside the server's renders directory" };
  }

  const options = parseRenderOptions(body);
  const project = prepareProjectDirectory(body.projectDir, options);
  if (project) return project;
  const source = await resolveInlineRenderHtml(body);
  return "error" in source ? source : materializeInlineProject(source.html, options);
}

function resolveOutputPath(
  projectDir: string,
  outputCandidate: string | null | undefined,
  rendersDir: string,
  log: ProducerLogger,
): string {
  try {
    return resolveRenderPaths(projectDir, outputCandidate, rendersDir).absoluteOutputPath;
  } catch (error) {
    const fallbackPath = resolve(rendersDir, `producer-fallback-${Date.now()}.mp4`);
    log.warn("Failed to resolve output path, using fallback", {
      fallback: fallbackPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackPath;
  }
}

// ---------------------------------------------------------------------------
// Output artifact management
// ---------------------------------------------------------------------------
interface OutputArtifact {
  path: string;
  expiresAtMs: number;
}

function createArtifactStore(ttlMs: number) {
  const artifacts = new Map<string, OutputArtifact>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [token, artifact] of artifacts.entries()) {
      if (artifact.expiresAtMs <= now) {
        artifacts.delete(token);
      }
    }
  }, 60_000);
  cleanup.unref();

  return {
    register(path: string): string {
      const token = crypto.randomUUID();
      artifacts.set(token, { path, expiresAtMs: Date.now() + ttlMs });
      return token;
    },
    get(token: string): OutputArtifact | undefined {
      return artifacts.get(token);
    },
    delete(token: string) {
      artifacts.delete(token);
    },
  };
}

function cleanupTempDir(dir: string | undefined, log: ProducerLogger): void {
  if (!dir) return;
  pendingTempDirs.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    log.warn("Failed to cleanup temp project dir", {
      cleanupProjectDir: dir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function outputFileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function createBlockingProgressReporter(log: ProducerLogger, requestId: string): ProgressCallback {
  let lastLoggedPct = -10;
  return (job, message) => {
    const pct = job.progress;
    if (pct < lastLoggedPct + 10) return;
    lastLoggedPct = pct;
    log.info(`render progress ${pct}%`, { requestId, stage: job.currentStage, message });
  };
}

interface SseWriter {
  writeSSE(event: { data: string }): Promise<void>;
}

async function prepareSseRenderRequest(
  c: Context,
  stream: SseWriter,
  requestId: string,
  rendersDir: string,
): Promise<PreparedRenderInput | null> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    await stream.writeSSE({
      data: JSON.stringify({
        type: "error",
        requestId,
        error: "Invalid JSON body",
        stage: "validation",
      }),
    });
    return null;
  }
  const prepared = await prepareRenderBody(body, rendersDir);
  if (!("error" in prepared)) return prepared.prepared;
  await stream.writeSSE({
    data: JSON.stringify({
      type: "error",
      requestId,
      error: prepared.error,
      stage: "validation",
    }),
  });
  return null;
}

function createSseProgressReporter(stream: SseWriter, requestId: string): ProgressCallback {
  return async (job, message) => {
    await stream.writeSSE({
      data: JSON.stringify({
        type: "progress",
        requestId,
        stage: job.currentStage,
        progress: job.progress,
        framesRendered: job.framesRendered ?? 0,
        totalFrames: job.totalFrames ?? 0,
        message,
      }),
    });
  };
}

async function writeRenderStreamFailure(input: {
  error: unknown;
  job: RenderJob;
  stream: SseWriter;
  requestId: string;
  startedAtMs: number;
  log: ProducerLogger;
}): Promise<void> {
  const { error, job, stream, requestId, startedAtMs, log } = input;
  if (error instanceof RenderCancelledError) {
    await stream.writeSSE({
      data: JSON.stringify({
        type: "cancelled",
        requestId,
        stage: job.currentStage,
        outcome: job.outcome ?? "cancelled",
        message: error.message,
      }),
    });
    return;
  }
  const errorMsg = error instanceof Error ? error.message : String(error);
  const safeError = extractSafeRenderErrorMetadata(error);
  const elapsedMs = Date.now() - startedAtMs;
  log.error("render-stream failed", {
    requestId,
    elapsedMs,
    error: errorMsg,
    stage: job.currentStage,
  });
  await stream.writeSSE({
    data: JSON.stringify({
      type: "error",
      requestId,
      error: errorMsg,
      errorCode: safeError?.errorCode,
      errorOwner: safeError?.errorOwner,
      retryable: safeError?.retryable,
      errorMetadata: safeError?.errorMetadata,
      stage: job.currentStage,
      elapsedMs,
      errorDetails: job.errorDetails ?? null,
      outcome: job.outcome ?? "failed",
      warnings: job.warnings,
    }),
  });
}

// ---------------------------------------------------------------------------
// Limits and small helpers
// ---------------------------------------------------------------------------
const DEFAULT_MAX_CONCURRENT_RENDERS = 2;
/**
 * Default request body cap for the JSON render/lint endpoints. Inline `html`
 * (including base64 data URIs) is the only large field; 64 MiB is far above any
 * realistic composition while still bounding memory. Override with
 * PRODUCER_MAX_BODY_BYTES.
 */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

function parsePositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/** A concurrency limit must be an integer >= 1; anything else falls back to the default (2). */
export function resolveMaxConcurrentRenders(value: unknown): number {
  return parsePositiveInteger(value) ?? DEFAULT_MAX_CONCURRENT_RENDERS;
}

/** Resolve the request body cap from PRODUCER_MAX_BODY_BYTES (positive integer) or the default. */
export function resolveMaxBodyBytes(value: unknown = process.env.PRODUCER_MAX_BODY_BYTES): number {
  return parsePositiveInteger(value) ?? DEFAULT_MAX_BODY_BYTES;
}

/** Optional overall render deadline (PRODUCER_RENDER_TIMEOUT_MS); 0 = disabled (default). */
export function resolveRenderTimeoutMs(
  value: unknown = process.env.PRODUCER_RENDER_TIMEOUT_MS,
): number {
  return parsePositiveInteger(value) ?? 0;
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function isAuthorizedBearer(header: string | undefined, token: string): boolean {
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  if (!match?.[1]) return false;
  // Hash both sides so the compared buffers have equal length regardless of input.
  const given = crypto.createHash("sha256").update(match[1]).digest();
  const expected = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(given, expected);
}

const OUTPUT_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".gif": "image/gif",
  ".png": "image/png",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
};

/** Content-Type for a rendered artifact, derived from its file extension. */
export function contentTypeForOutput(path: string): string {
  return OUTPUT_CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------
export interface RenderHandlers {
  render: (c: Context) => Promise<Response>;
  renderStream: (c: Context) => Response | Promise<Response>;
  lint: (c: Context) => Promise<Response>;
  health: (c: Context) => Response;
  outputs: (c: Context) => Response;
  queue: (c: Context) => Response;
  /** Abort every in-flight or queued render (used on shutdown). */
  abortActiveRenders: (reason?: unknown) => void;
  /** Renders currently tracked (queued + running). */
  activeRenderCount: () => number;
}

/**
 * Create route handler functions for the producer server.
 *
 * These can be mounted on any Hono app at any path prefix.
 */
export function createRenderHandlers(options: HandlerOptions = {}): RenderHandlers {
  const log = options.logger ?? defaultLogger;
  const getRequestId =
    options.getRequestId ?? ((c: Context) => c.req.header("x-request-id") || crypto.randomUUID());
  const outputUrlPrefix = options.outputUrlPrefix ?? "/outputs";
  const rendersDir = options.rendersDir ?? process.env.PRODUCER_RENDERS_DIR ?? tmpdir();
  const artifactTtlMs =
    options.artifactTtlMs ?? Number(process.env.PRODUCER_OUTPUT_ARTIFACT_TTL_MS || 15 * 60 * 1000);
  const store = createArtifactStore(artifactTtlMs);
  const maxConcurrentRenders = resolveMaxConcurrentRenders(
    options.maxConcurrentRenders ?? process.env.PRODUCER_MAX_CONCURRENT_RENDERS,
  );
  const renderTimeoutMs = resolveRenderTimeoutMs();
  const renderSemaphore = new Semaphore(maxConcurrentRenders);
  const activeRenders = new Set<AbortController>();

  /**
   * Per-render abort scope: aborts on client disconnect, shutdown, or (when
   * configured) the overall deadline. `armDeadline` starts the timer once the
   * render actually holds a slot so queue time doesn't count against it.
   */
  const trackRender = (requestSignal: AbortSignal) => {
    const controller = new AbortController();
    activeRenders.add(controller);
    const onRequestAbort = () => controller.abort(new RenderCancelledError("request_aborted"));
    if (requestSignal.aborted) onRequestAbort();
    else requestSignal.addEventListener("abort", onRequestAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      signal: controller.signal,
      armDeadline(): void {
        if (renderTimeoutMs <= 0 || timer) return;
        timer = setTimeout(
          () => controller.abort(new RenderCancelledError("render_timeout", "timeout")),
          renderTimeoutMs,
        );
        timer.unref();
      },
      dispose(): void {
        if (timer) clearTimeout(timer);
        requestSignal.removeEventListener("abort", onRequestAbort);
        activeRenders.delete(controller);
      },
    };
  };
  const abortActiveRenders = (reason: unknown = new RenderCancelledError("server_shutdown")) => {
    for (const controller of activeRenders) controller.abort(reason);
  };
  const startTime = Date.now();

  const health = (c: Context): Response =>
    c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });

  const lint = async (c: Context): Promise<Response> => {
    const requestId = getRequestId(c);

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, requestId, error: "Invalid JSON body" }, 400);
    }

    const preparedResult = prepareHyperframeLintBody(body);
    if ("error" in preparedResult) {
      return c.json({ success: false, requestId, error: preparedResult.error }, 400);
    }

    const result = await runHyperframeLint(preparedResult.prepared);
    log.info("lint completed", {
      requestId,
      entryFile: preparedResult.prepared.entryFile,
      source: preparedResult.prepared.source,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
    });

    return c.json({
      success: true,
      requestId,
      entryFile: preparedResult.prepared.entryFile,
      source: preparedResult.prepared.source,
      result,
    });
  };

  const render = async (c: Context): Promise<Response> => {
    const requestId = getRequestId(c);
    const t0 = Date.now();

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, requestId, error: "Invalid JSON body" }, 400);
    }

    const preparedResult = await prepareRenderBody(body, rendersDir);
    if ("error" in preparedResult) {
      return c.json({ success: false, requestId, error: preparedResult.error }, 400);
    }

    const { input, cleanupProjectDir, absoluteOutputPath } = resolvePreparedRenderOutput(
      preparedResult.prepared,
      rendersDir,
      log,
    );

    const tracked = trackRender(c.req.raw.signal);
    let release: (() => void) | undefined;
    let job: ReturnType<typeof createRenderJob> | undefined;
    try {
      // Abortable wait: a client that disconnects while queued never takes a slot.
      release = await renderSemaphore.acquire(tracked.signal);
      tracked.armDeadline();
      log.info("render started", {
        requestId,
        projectDir: input.projectDir,
        fps: input.fps,
        quality: input.quality,
      });
      // Built inside the try so a bad option (e.g. workers: 0) can't leak the semaphore slot or temp dir.
      const renderJob = createRenderJob(
        buildRenderJobConfig(
          input,
          absoluteOutputPath,
          log,
          shouldRestrictExternalAssets(cleanupProjectDir !== undefined),
        ),
      );
      job = renderJob;
      await executeRenderJob(
        renderJob,
        input.projectDir,
        absoluteOutputPath,
        createBlockingProgressReporter(log, requestId),
        tracked.signal,
      );

      const fileSize = outputFileSize(absoluteOutputPath);
      const durationMs = Date.now() - t0;
      const outputToken = store.register(absoluteOutputPath);
      const outputUrl = `${outputUrlPrefix}/${outputToken}`;
      log.info("render completed", {
        requestId,
        durationMs,
        fileSize,
        perf: renderJob.perfSummary ?? null,
      });

      return c.json({
        success: true,
        requestId,
        outputPath: absoluteOutputPath,
        outputToken,
        outputUrl,
        fileSize,
        durationMs,
        videoDurationSeconds: job.duration ?? null,
        outcome: job.outcome ?? "completed",
        warnings: job.warnings,
        perf: job.perfSummary ?? null,
      });
    } catch (error) {
      const durationMs = Date.now() - t0;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const safeError = extractSafeRenderErrorMetadata(error);
      log.error("render failed", {
        requestId,
        durationMs,
        error: errorMsg,
        stage: job?.currentStage,
      });
      return c.json(
        {
          success: false,
          requestId,
          error: errorMsg,
          errorCode: safeError?.errorCode,
          errorOwner: safeError?.errorOwner,
          retryable: safeError?.retryable,
          errorMetadata: safeError?.errorMetadata,
          stage: job?.currentStage,
          durationMs,
          errorDetails: job?.errorDetails ?? null,
        },
        error instanceof RenderCancelledError ? (error.reason === "timeout" ? 504 : 503) : 500,
      );
    } finally {
      release?.();
      tracked.dispose();
      cleanupTempDir(cleanupProjectDir, log);
    }
  };

  const renderStream = (c: Context) => {
    return streamSSE(c, async (stream) => {
      const requestId = getRequestId(c);
      const t0 = Date.now();

      const prepared = await prepareSseRenderRequest(c, stream, requestId, rendersDir);
      if (!prepared) return;

      const { input, cleanupProjectDir, absoluteOutputPath } = resolvePreparedRenderOutput(
        prepared,
        rendersDir,
        log,
      );

      const tracked = trackRender(c.req.raw.signal);
      let release: (() => void) | undefined;
      let job: RenderJob | undefined;
      try {
        log.info("render-stream started", { requestId, projectDir: input.projectDir });
        // Built inside the try so a bad option can't leak the temp dir.
        const renderJob = createRenderJob(
          buildRenderJobConfig(
            input,
            absoluteOutputPath,
            log,
            shouldRestrictExternalAssets(cleanupProjectDir !== undefined),
          ),
        );
        job = renderJob;

        if (tracked.signal.aborted) return; // client left before we even queued
        if (renderSemaphore.activeCount >= maxConcurrentRenders) {
          await stream.writeSSE({
            data: JSON.stringify({
              type: "queued",
              requestId,
              position: renderSemaphore.waitingCount,
            }),
          });
        }
        // Abortable wait: a client that disconnected while queued never starts a render.
        release = await renderSemaphore.acquire(tracked.signal);
        tracked.armDeadline();

        await executeRenderJob(
          renderJob,
          input.projectDir,
          absoluteOutputPath,
          createSseProgressReporter(stream, requestId),
          tracked.signal,
        );

        const fileSize = outputFileSize(absoluteOutputPath);
        const outputToken = store.register(absoluteOutputPath);
        const outputUrl = `${outputUrlPrefix}/${outputToken}`;
        log.info("render-stream completed", {
          requestId,
          fileSize,
          perf: renderJob.perfSummary ?? null,
        });
        await stream.writeSSE({
          data: JSON.stringify({
            type: "complete",
            requestId,
            outputPath: absoluteOutputPath,
            outputToken,
            outputUrl,
            fileSize,
            videoDurationSeconds: renderJob.duration ?? null,
            outcome: renderJob.outcome ?? "completed",
            warnings: renderJob.warnings,
            perf: renderJob.perfSummary ?? null,
          }),
        });
      } catch (error) {
        if (job) {
          await writeRenderStreamFailure({
            error,
            job,
            stream,
            requestId,
            startedAtMs: t0,
            log,
          });
        } else {
          const message = error instanceof Error ? error.message : String(error);
          log.error("render-stream failed before start", { requestId, error: message });
          await stream
            .writeSSE({
              data: JSON.stringify({ type: "error", requestId, error: message, stage: "setup" }),
            })
            .catch(() => {});
        }
      } finally {
        release?.();
        tracked.dispose();
        cleanupTempDir(cleanupProjectDir, log);
      }
    });
  };

  const outputs = (c: Context): Response => {
    const token = c.req.param("token") ?? "";
    const artifact = store.get(token);
    if (!artifact) {
      return c.json({ success: false, error: "Output artifact not found or expired" }, 404);
    }
    if (!existsSync(artifact.path)) {
      store.delete(token);
      return c.json({ success: false, error: "Output artifact file missing" }, 404);
    }
    const stats = statSync(artifact.path);
    if (!stats.isFile()) {
      // png-sequence / hls outputs are directories; there is no single file to stream.
      return c.json({ success: false, error: "Output artifact is not a single file" }, 404);
    }
    const fileStream = createReadStream(artifact.path);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        fileStream.on("data", (chunk) => {
          controller.enqueue(
            typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk),
          );
          if ((controller.desiredSize ?? 1) <= 0) fileStream.pause();
        });
        fileStream.once("end", () => controller.close());
        fileStream.once("error", (error) => {
          log.warn("output stream failed", { error: error.message });
          controller.error(error);
        });
      },
      pull() {
        fileStream.resume();
      },
      cancel() {
        fileStream.destroy();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": contentTypeForOutput(artifact.path),
        "content-length": String(stats.size),
        "cache-control": "no-store",
      },
    });
  };

  const queue = (c: Context): Response =>
    c.json({
      maxConcurrentRenders,
      activeRenders: renderSemaphore.activeCount,
      queuedRenders: renderSemaphore.waitingCount,
    });

  return {
    render,
    renderStream,
    lint,
    health,
    outputs,
    queue,
    abortActiveRenders,
    activeRenderCount: () => activeRenders.size,
  };
}

// ---------------------------------------------------------------------------
// Public app factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono app with clean public routes for OSS use.
 */
export function createProducerApp(options: HandlerOptions = {}): Hono {
  return buildProducerApp(options).app;
}

function buildProducerApp(options: HandlerOptions): { app: Hono; handlers: RenderHandlers } {
  const app = new Hono();
  const handlers = createRenderHandlers(options);
  // Optional bearer auth. Read per request so the env var can be set after startup in tests.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const token = options.authToken ?? process.env.PRODUCER_AUTH_TOKEN;
    if (!token) return next();
    if (!isAuthorizedBearer(c.req.header("authorization"), token)) {
      return c.json({ success: false, error: "Unauthorized" }, 401, {
        "www-authenticate": "Bearer",
      });
    }
    return next();
  });
  const maxBodyBytes = resolveMaxBodyBytes();
  const limitBody = bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) =>
      c.json(
        {
          success: false,
          error: `Request body exceeds ${maxBodyBytes} bytes (PRODUCER_MAX_BODY_BYTES)`,
        },
        413,
      ),
  });

  app.get("/health", handlers.health);
  app.post("/render", limitBody, handlers.render);
  app.post("/render/stream", limitBody, handlers.renderStream);
  app.get("/render/queue", handlers.queue);
  app.post("/lint", limitBody, handlers.lint);
  app.get("/outputs/:token", handlers.outputs);

  return { app, handlers };
}

// ---------------------------------------------------------------------------
// Standalone server
// ---------------------------------------------------------------------------

function isNodeHttpServer(server: object): server is HttpServer {
  return "keepAliveTimeout" in server && "headersTimeout" in server;
}

/**
 * Start the producer HTTP server with graceful shutdown.
 */
export function startServer(options: ServerOptions = {}) {
  const port = options.port ?? parseInt(process.env.PRODUCER_PORT ?? "9847", 10);
  const log = options.logger ?? defaultLogger;
  const { app, handlers } = buildProducerApp(options);

  const hostname = options.hostname ?? process.env.PRODUCER_HOST ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname }, () => {
    log.info(`Listening on http://${hostname}:${port}`);
  });

  // Long renders: no whole-request or socket-idle timeout. Keep-alive and header
  // timeouts stay non-zero so idle/slow-header connections (slowloris) are reaped.
  server.setTimeout(0);
  if (isNodeHttpServer(server)) {
    server.requestTimeout = 0;
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
  }

  // Start the worker-thread health endpoint alongside the main listener.
  // The main thread keeps serving /health on `port` for backwards
  // compatibility; the worker thread additionally serves /health on
  // PRODUCER_HEALTH_PORT (default 9848) so k8s liveness/readiness probes can
  // migrate to a listener that doesn't share an event loop with renders.
  //
  // Opt-out: set PRODUCER_DISABLE_HEALTH_WORKER=1 (e.g. for tests that don't
  // want a worker spawned, or for environments where the extra port isn't
  // wanted).
  //
  // We store the *promise* (not the resolved handle) so a SIGTERM that
  // arrives before the worker has finished booting still has something to
  // await. Awaiting a `let healthWorker = null` mutated from inside `.then`
  // would race: if SIGTERM lands before the `.then` callback fires,
  // `shutdown()` sees `null` and skips worker cleanup. The promise pattern
  // closes that window without making startup blocking.
  const healthWorkerPromise: Promise<HealthWorkerHandle | null> =
    process.env.PRODUCER_DISABLE_HEALTH_WORKER === "1"
      ? Promise.resolve(null)
      : startHealthWorker({ logger: log }).catch((err: Error) => {
          // Don't crash the producer if the worker fails to start — the main
          // /health is still up. Log loudly so the operator notices.
          log.error(`[server] health worker failed to start: ${err.message}`);
          return null;
        });

  async function shutdown(signal: string) {
    log.info(`Received ${signal}, shutting down`);
    // Stop in-flight renders first so their own cleanup runs, then reap any
    // stragglers (ffmpeg children, browsers) and leftover temp project dirs.
    handlers.abortActiveRenders();
    const drainDeadline = Date.now() + 5_000;
    while (handlers.activeRenderCount() > 0 && Date.now() < drainDeadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    killTrackedProcesses();
    removePendingTempProjectDirs();
    await drainBrowserPool().catch(() => {});
    // Bounded await: if the worker hasn't come online within 1.5s of
    // shutdown there's no useful cleanup left to do — `worker.terminate()`
    // from process exit will kill the thread regardless, and we'd rather
    // not let a hung-startup worker keep the SIGTERM path waiting.
    const handle = await Promise.race<HealthWorkerHandle | null>([
      healthWorkerPromise,
      new Promise<null>((res) => setTimeout(() => res(null), 1_500).unref()),
    ]);
    if (handle) {
      await handle.shutdown().catch(() => {});
    }
    if (isNodeHttpServer(server)) server.closeIdleConnections();
    server.close(() => {
      log.info("Server closed");
      process.exit(0);
    });
    setTimeout(() => {
      log.warn("Forced exit after 30s timeout");
      process.exit(1);
    }, 30_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}

// ---------------------------------------------------------------------------
// Self-executable: node dist/public-server.js
// ---------------------------------------------------------------------------
// Only auto-start when this file is the explicit entry point.
// In esbuild bundles, import.meta.url is shared across inlined modules,
// so we check argv[1] against known public server filenames.
const entryScript = process.argv[1] ? resolve(process.argv[1]).replace(/\\/g, "/") : "";
const isPublicServerEntry =
  entryScript.endsWith("/public-server.js") || entryScript.endsWith("/src/server.ts");

if (isPublicServerEntry) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p", default: process.env.PRODUCER_PORT ?? "9847" },
    },
  });
  startServer({ port: parseInt(values.port as string, 10) });
}

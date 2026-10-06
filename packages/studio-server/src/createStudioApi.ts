import { Hono } from "hono";
import type { StudioApiAdapter } from "./types.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerPreviewRoutes } from "./routes/preview.js";
import { registerLintRoutes } from "./routes/lint.js";
import { registerRenderRoutes } from "./routes/render.js";
import { registerImageThumbnailRoutes } from "./routes/imageThumbnail.js";
import { registerThumbnailRoutes } from "./routes/thumbnail.js";
import { registerWaveformRoutes } from "./routes/waveform.js";
import { registerFreezeFrameRoutes } from "./routes/freezeFrame.js";
import { registerLoudnessRoutes } from "./routes/loudness.js";
import { registerPeakRoutes } from "./routes/peaks.js";
import { registerFontRoutes } from "./routes/fonts.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import { registerSelectionRoutes } from "./routes/selection.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerGlobalAssetRoutes } from "./routes/globalAssets.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { replaceWithProjectDirMissing } from "./helpers/projectDirMissing.js";
import { hostPolicyFromEnv, isAllowedHost } from "./helpers/hostAllowlist.js";
import { folderGone, isProjectRootMissing } from "./helpers/safePath.js";

/**
 * A browser always sends Origin on cross-site writes, so a foreign page can't drive
 * the preview API. Non-browser clients (CLI, curl) send no Origin and pass.
 */
export function isCrossOriginWrite(
  method: string,
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin || method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // malformed Origin, including the literal "null"
  }
}

/**
 * Create a Hono sub-app with all studio API routes.
 *
 * Both the vite dev server and CLI embedded server mount this app
 * under /api, each providing their own adapter for host-specific behavior.
 */
export function createStudioApi(adapter: StudioApiAdapter): Hono {
  const api = new Hono();
  // DNS-rebinding guard for EVERY /api route, reads included: a rebinding page reads data as same-origin.
  api.use(async function rejectForeignHost(c, next) {
    const policy = adapter.hostPolicy?.() ?? hostPolicyFromEnv();
    if (!isAllowedHost(c.req.header("host"), policy)) {
      return c.json({ error: "forbidden", why: "host_not_allowed" }, 403);
    }
    await next();
  });
  api.use(async function rejectCrossOriginWrites(c, next) {
    if (isCrossOriginWrite(c.req.method, c.req.header("origin"), c.req.header("host"))) {
      return c.json({ error: "forbidden", why: "cross_origin" }, 403);
    }
    await next();
  });
  api.use(async function answerProjectDirMissingAfterErrorHandlers(c, next) {
    const hostHeaders = new Headers(c.res.headers);
    await next();
    if (isProjectRootMissing(c.error)) replaceWithProjectDirMissing(c, hostHeaders);
  });
  api.use("/projects/:id/*", async function answerProjectDirMissingForVanishedFolder(c, next) {
    const hostHeaders = new Headers(c.res.headers);
    const dirBeforeRoute = await Promise.resolve()
      .then(() => adapter.resolveProject(c.req.param("id")))
      .then(
        (project) => project?.dir,
        () => undefined,
      );
    await next();
    if (c.res.status >= 403 && dirBeforeRoute && folderGone(dirBeforeRoute))
      replaceWithProjectDirMissing(c, hostHeaders);
  });
  api.use("/projects/:id/*", async function forgetSignatureAfterWrite(c, next) {
    await next();
    if (c.req.method === "GET" || c.req.method === "HEAD") return;
    const project = await Promise.resolve()
      .then(() => adapter.resolveProject(c.req.param("id")))
      .catch(() => null);
    if (project) adapter.invalidateProjectSignature?.(project.dir);
  });
  api.use("/projects/:id/*", async function openHistorySoNoWriteBecomesItsBaseline(c, next) {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && adapter.history) {
      await Promise.resolve()
        .then(() => adapter.resolveProject(c.req.param("id")))
        .then((project) => project && adapter.history?.(project))
        .catch(() => null);
    }
    await next();
  });

  registerProjectRoutes(api, adapter);
  registerFileRoutes(api, adapter);
  registerPreviewRoutes(api, adapter);
  registerLintRoutes(api, adapter);
  registerRenderRoutes(api, adapter);
  registerThumbnailRoutes(api, adapter);
  registerImageThumbnailRoutes(api, adapter);
  registerSelectionRoutes(api, adapter);
  registerMediaRoutes(api, adapter);
  registerWaveformRoutes(api, adapter);
  registerFreezeFrameRoutes(api, adapter);
  registerLoudnessRoutes(api, adapter);
  registerPeakRoutes(api, adapter);
  registerFontRoutes(api);
  registerRegistryRoutes(api, adapter);
  registerGlobalAssetRoutes(api);
  registerHistoryRoutes(api, adapter);

  return api;
}

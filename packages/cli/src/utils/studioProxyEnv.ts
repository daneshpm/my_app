export function studioProxyEnv(
  autoProxy: boolean,
  baseEnv: NodeJS.ProcessEnv = process.env,
  preview?: {
    projectDir: string;
    projectName: string;
    browserGpuMode?: "auto" | "hardware" | "software";
  },
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    TAGREEL_AUTO_PROXY: autoProxy ? "true" : "false",
    ...(preview
      ? {
          TAGREEL_PREVIEW_PROJECT_DIR: preview.projectDir,
          TAGREEL_PREVIEW_PROJECT_NAME: preview.projectName,
          ...(preview.browserGpuMode
            ? { TAGREEL_PREVIEW_BROWSER_GPU_MODE: preview.browserGpuMode }
            : {}),
        }
      : {}),
  };
}

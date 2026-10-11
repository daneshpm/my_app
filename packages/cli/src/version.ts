declare const __CLI_NAME__: string | undefined;
declare const __CLI_VERSION__: string | undefined;
declare const __PRODUCER_VERSION__: string | undefined;
export const VERSION = typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "0.0.0-dev";
export const PRODUCER_VERSION =
  typeof __PRODUCER_VERSION__ !== "undefined" ? __PRODUCER_VERSION__ : "0.0.0-dev";
/** npm package name, injected from package.json at build time. */
export const PACKAGE_NAME = typeof __CLI_NAME__ !== "undefined" ? __CLI_NAME__ : "tagreel";

/**
 * Single source of truth for the GitHub repository this CLI pulls its registry,
 * skills and issue links from. Renaming the project is a change to the two
 * constants below.
 */
export const PROJECT_REPO_OWNER = "daneshpm";
export const PROJECT_REPO_NAME = "my_app";
export const PROJECT_REPO_SLUG = `${PROJECT_REPO_OWNER}/${PROJECT_REPO_NAME}`;
export const PROJECT_REPO_URL = `https://github.com/${PROJECT_REPO_SLUG}`;
export const ISSUES_URL = `${PROJECT_REPO_URL}/issues`;

/** Built-in registry base URL. `TAGREEL_REGISTRY` overrides it. */
export const DEFAULT_RAW_REGISTRY_URL = `https://raw.githubusercontent.com/${PROJECT_REPO_SLUG}/main/registry`;
export const RAW_REGISTRY_URL = process.env["TAGREEL_REGISTRY"] || DEFAULT_RAW_REGISTRY_URL;

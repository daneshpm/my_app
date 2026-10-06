import { createHash } from "node:crypto";

/**
 * Turn an authored element id into one filesystem-safe path segment.
 *
 * Ids come from composition HTML, so `../..` or `a/b` must never reach `join()`.
 * Ids that are already `[A-Za-z0-9_-]+` pass through unchanged. Anything else is
 * sanitized and gets a short hash of the original, so two ids that sanitize alike
 * (`a/b`, `a?b`) still land on distinct paths.
 */
export function safeIdSegment(id: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(id)) return id;
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_") || "id";
  const hash = createHash("sha1").update(id).digest("hex").slice(0, 8);
  return `${cleaned}-${hash}`;
}

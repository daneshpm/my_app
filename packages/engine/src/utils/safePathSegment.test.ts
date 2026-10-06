import { describe, expect, it } from "vitest";
import { safeIdSegment } from "./safePathSegment";

describe("safeIdSegment", () => {
  it("passes already-safe ids through unchanged", () => {
    expect(safeIdSegment("narration_1-b")).toBe("narration_1-b");
  });

  it("neutralizes traversal and separators", () => {
    for (const id of ["../../x", "..", "a/b", "a\\b", "C:\\x", ""]) {
      const seg = safeIdSegment(id);
      expect(seg).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("keeps ids that sanitize alike on distinct segments", () => {
    expect(safeIdSegment("a/b")).not.toBe(safeIdSegment("a?b"));
  });
});

import { describe, expect, it } from "vitest";
import { isTagreelProject } from "./projectRule";

describe("isTagreelProject", () => {
  it.each(["tagreel.json", "meta.json", "project.json"])(
    "counts a folder with index.html and %s",
    (marker) => {
      expect(isTagreelProject(["index.html", marker, "assets"])).toBe(true);
    },
  );

  it("does not count index.html alone, or a marker without index.html", () => {
    expect(isTagreelProject(["index.html", "package.json"])).toBe(false);
    expect(isTagreelProject(["tagreel.json", "README.md"])).toBe(false);
  });
});

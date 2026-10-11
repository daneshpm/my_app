import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validRegistryName, validRegistryManifest, validRegistryItem } from "./validation.js";

const item = {
  name: "demo",
  type: "tagreel:component",
  title: "Demo",
  description: "Example",
  files: [{ path: "demo.html", target: "components/demo.html", type: "tagreel:snippet" }],
};

describe("registry manifest boundary", () => {
  it("rejects cache-key traversal and marker breakouts", () => {
    for (const name of ["x/../../../.config/tool", "demo -->", "a".repeat(129)])
      expect(validRegistryName(name)).toBe(false);
    expect(validRegistryName("demo-2")).toBe(true);
  });
  it("validates the published item schema and requested identity", () => {
    expect(validRegistryItem(item, "demo", "tagreel:component")).toBe(true);
    expect(validRegistryItem(item, "other", "tagreel:component")).toBe(false);
    expect(validRegistryItem(item, "demo", "tagreel:block")).toBe(false);
    expect(
      validRegistryItem(
        { ...item, files: [{ ...item.files[0], target: "../outside" }] },
        "demo",
        "tagreel:component",
      ),
    ).toBe(false);
  });
  it("validates cached and remote top-level manifest shape and cardinality", () => {
    const manifest = {
      name: "registry",
      homepage: "https://registry.example",
      items: [{ name: "demo", type: "tagreel:component" }],
    };
    expect(validRegistryManifest(manifest)).toBe(true);
    expect(validRegistryManifest({ ...manifest, items: [{ name: "../outside" }] })).toBe(false);
    expect(
      validRegistryManifest({ ...manifest, items: Array(10_001).fill(manifest.items[0]) }),
    ).toBe(false);
  });
  it("accepts every registry-item.json the repo publishes", () => {
    const registry = join(import.meta.dirname, "../../../../registry");
    const rejected = readdirSync(registry, { withFileTypes: true })
      .filter((dir) => dir.isDirectory())
      .flatMap((dir) =>
        readdirSync(join(registry, dir.name)).map((name) => ({ dir: dir.name, name })),
      )
      .filter(({ dir, name }) => existsSync(join(registry, dir, name, "registry-item.json")))
      .filter(({ dir, name }) => {
        const item = JSON.parse(
          readFileSync(join(registry, dir, name, "registry-item.json"), "utf8"),
        );
        return !validRegistryItem(item, name, item.type);
      })
      .map(({ dir, name }) => `${dir}/${name}`);
    expect(rejected).toEqual([]);
  });
});

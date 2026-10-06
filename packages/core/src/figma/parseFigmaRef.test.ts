// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseFigmaRef } from "./parseFigmaRef";

describe("parseFigmaRef", () => {
  it("extracts fileKey + nodeId from a /design/ URL and converts node-id dashes to colons", () => {
    const ref = parseFigmaRef(
      "https://www.figma.com/design/JjiZQGiUKqbkPCs3sviEUF/Playground?node-id=92-573&t=x",
    );
    expect(ref.fileKey).toBe("JjiZQGiUKqbkPCs3sviEUF");
    expect(ref.nodeId).toBe("92:573");
  });

  it("handles /file/ URLs without a node-id", () => {
    const ref = parseFigmaRef("https://figma.com/file/ABC123/Name");
    expect(ref.fileKey).toBe("ABC123");
    expect(ref.nodeId).toBeUndefined();
  });

  it("accepts fileKey:nodeId shorthand", () => {
    expect(parseFigmaRef("ABC123:1-2")).toEqual({ fileKey: "ABC123", nodeId: "1:2" });
  });

  it("accepts a bare fileKey", () => {
    expect(parseFigmaRef("ABC123")).toEqual({ fileKey: "ABC123" });
  });

  it("throws on empty input", () => {
    expect(() => parseFigmaRef("   ")).toThrow();
  });
});

describe("normalizeNodeId multi-segment", () => {
  it("converts every dash in a multi-segment node id", () => {
    expect(parseFigmaRef("KEY:1-2-3").nodeId).toBe("1:2:3");
  });
});

describe("parseFigmaRef bare-ref validation", () => {
  it("rejects bare refs whose fileKey is not alphanumeric", () => {
    expect(() => parseFigmaRef("../../etc")).toThrow(/no fileKey/);
    expect(() => parseFigmaRef("abc?x=1")).toThrow(/invalid ref/);
    expect(() => parseFigmaRef("ab%2Fcd:1-2")).toThrow(/invalid ref/);
    expect(parseFigmaRef("AbC123:1-2")).toEqual({ fileKey: "AbC123", nodeId: "1:2" });
    expect(parseFigmaRef("AbC123")).toEqual({ fileKey: "AbC123" });
  });
});

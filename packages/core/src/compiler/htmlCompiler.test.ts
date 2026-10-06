import { describe, expect, it, vi } from "vitest";
import { compileHtml } from "./htmlCompiler.js";

describe("compileHtml", () => {
  it("preserves explicit looped media durations that exceed source duration", async () => {
    const html =
      '<video id="hero" src="hero.webm" data-start="0" data-duration="4" data-end="4" loop>';

    const compiled = await compileHtml(html, "/project", async () => 3.125);

    expect(compiled).toContain('data-duration="4"');
    expect(compiled).toContain('data-end="4"');
  });

  it("preserves an explicit non-looping video slot past source end", async () => {
    const html = '<video id="hero" src="hero.webm" data-start="0" data-duration="4" data-end="4">';

    const compiled = await compileHtml(html, "/project", async () => 3.125);

    expect(compiled).toContain('data-duration="4"');
    expect(compiled).toContain('data-end="4"');
  });

  it("uses natural duration for a video without an explicit slot inside a composition", async () => {
    const html =
      '<div data-composition-id="root" data-start="0" data-duration="5">' +
      '<video id="hero" src="hero.webm" data-start="0">' +
      "</div>";

    const compiled = await compileHtml(html, "/project", async () => 1);

    expect(compiled).toContain('data-duration="1"');
    expect(compiled).toContain('data-end="1"');
  });

  it("uses natural duration for a standalone video without a composition window", async () => {
    const html = '<video id="hero" src="hero.webm" data-start="0">';
    const compiled = await compileHtml(html, "/project", async () => 1);
    expect(compiled).toContain('data-duration="1"');
    expect(compiled).toContain('data-end="1"');
  });

  it("still clamps non-looping audio durations to source duration", async () => {
    const html = '<audio id="voice" src="voice.wav" data-start="0" data-duration="4" data-end="4">';

    const compiled = await compileHtml(html, "/project", async () => 3.125);

    expect(compiled).toContain('data-duration="3.125"');
    expect(compiled).toContain('data-end="3.125"');
  });

  it("preserves explicit media durations when probe precision differs slightly", async () => {
    const html =
      '<audio id="click" src="click.mp3" data-start="0" data-duration="1.044898" data-end="1.044898">';

    const compiled = await compileHtml(html, "/project", async () => 1);

    expect(compiled).toContain('data-duration="1.044898"');
    expect(compiled).toContain('data-end="1.044898"');
  });
});

describe("resolveMediaSrc", () => {
  it("strips query/fragment, treats a leading slash as project-root-relative, and refuses escapes", async () => {
    const { resolveMediaSrc } = await import("./htmlCompiler.js");
    const { resolve } = await import("node:path");
    const root = resolve("/project");
    expect(resolveMediaSrc("clip.mp4?v=2#t=1", "/project")).toBe(resolve(root, "clip.mp4"));
    expect(resolveMediaSrc("/assets/clip.mp4", "/project")).toBe(
      resolve(root, "assets", "clip.mp4"),
    );
    expect(resolveMediaSrc("https://cdn.example.com/a.mp4", "/project")).toBe(
      "https://cdn.example.com/a.mp4",
    );
    expect(resolveMediaSrc("../../etc/passwd", "/project")).toBeNull();
    expect(resolveMediaSrc("data:audio/wav;base64,AAAA", "/project")).toBeNull();
  });

  it("does not probe a src that escapes the project", async () => {
    const probe = vi.fn(async () => 5);
    await compileHtml(
      '<video id="v" src="../../secret.mp4" data-start="0"></video>',
      "/project",
      probe,
    );
    expect(probe).not.toHaveBeenCalled();
  });
});

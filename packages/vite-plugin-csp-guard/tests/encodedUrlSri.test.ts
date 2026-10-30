import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load } from "cheerio";
import { build } from "vite";
import { afterEach, describe, expect, test } from "vitest";
import vitePluginCSP from "../src/index";
import { processHtmlForSri } from "../src/sri/processHtml";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("SRI with URL-encoded filenames", () => {
  test.each([
    { fileName: "café-x.js", url: "caf%C3%A9-x.js" },
    { fileName: "space name.js", url: "space%20name.js" },
  ])("matches URL-encoded filename $fileName", ({ fileName, url }) => {
    const value = "sha256-encoded-filename";
    const html = processHtmlForSri(
      `<script src="/assets/${url}"></script>`,
      { [`/assets/${fileName}`]: value },
      new Set(),
      "/",
    );

    expect(load(html)("script").attr("integrity")).toBe(value);
  });

  test("does not decode encoded reserved path separators", () => {
    const html = processHtmlForSri(
      '<script src="/assets/foo%2Fbar.js"></script>',
      { "/assets/foo/bar.js": "sha256-ambiguous" },
      new Set(),
      "/",
    );

    expect(load(html)("script").attr("integrity")).toBeUndefined();
  });

  test("does not duplicate a Vite preload with a raw non-ASCII href", () => {
    const html = processHtmlForSri(
      '<link rel="modulepreload" href="/assets/café.js">',
      { "/assets/café.js": "sha256-café" },
      new Set(["assets/café.js"]),
      "/",
    );

    expect(load(html)("link[rel='modulepreload']")).toHaveLength(1);
  });

  test("adds SRI to a Vite entry with a non-ASCII output filename", async () => {
    const tempDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "csp-guard-encoded-entry-")),
    );
    tempDirectories.push(tempDir);
    const fixtureDir = path.join(tempDir, "fixture");
    const outDir = path.join(tempDir, "dist");
    await mkdir(path.join(fixtureDir, "src"), { recursive: true });
    await writeFile(
      path.join(fixtureDir, "index.html"),
      '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
    );
    await writeFile(
      path.join(fixtureDir, "src/main.js"),
      "window.encodedEntry = true;",
    );

    await build({
      configFile: false,
      root: fixtureDir,
      logLevel: "silent",
      plugins: [vitePluginCSP({ build: { sri: true } })],
      build: {
        outDir,
        emptyOutDir: true,
        rolldownOptions: {
          output: { entryFileNames: "assets/café-[hash].js" },
        },
      },
    });

    const assets = await readdir(path.join(outDir, "assets"));
    const entryName = assets.find(
      (name) => name.startsWith("café-") && name.endsWith(".js"),
    );
    expect(entryName).toBeDefined();
    const entryCode = await readFile(
      path.join(outDir, "assets", entryName!),
      "utf8",
    );
    const html = await readFile(path.join(outDir, "index.html"), "utf8");
    const $ = load(html);
    const entryScript = $("script[type='module'][src]").first();
    const expectedIntegrity = `sha256-${createHash("sha256")
      .update(entryCode)
      .digest("base64")}`;

    // Vite preserves the raw Unicode filename in the emitted href; generated
    // preloads use the same form, so the existing-href dedupe remains exact.
    expect(entryScript.attr("src")).toBe(`/assets/${entryName}`);
    expect(entryScript.attr("integrity")).toBe(expectedIntegrity);
  });
});

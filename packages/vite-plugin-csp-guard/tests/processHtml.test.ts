import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
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

const integrity = "sha256-local-bundle";
const sriByPathname = { "/assets/main.js": integrity };

describe("processHtmlForSri asset-origin matching", () => {
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

  test("leaves third-party URLs with the same pathname untouched for a path base", () => {
    const html = processHtmlForSri(
      `<script src="https://third-party.example/assets/main.js" integrity="sha256-author"></script><script src="https://third-party.example/assets/main.js?without-integrity"></script>`,
      sriByPathname,
      new Set(),
      "/",
      "anonymous",
    );
    const $ = load(html);
    const scripts = $("script");

    expect(scripts.eq(0).attr("integrity")).toBe("sha256-author");
    expect(scripts.eq(0).attr("crossorigin")).toBeUndefined();
    expect(scripts.eq(1).attr("integrity")).toBeUndefined();
    expect(scripts.eq(1).attr("crossorigin")).toBeUndefined();
  });

  test("matches only the full-URL base origin", () => {
    const html = processHtmlForSri(
      `<script src="https://cdn.example.com/assets/main.js"></script><script src="https://third-party.example/assets/main.js"></script><script src="/assets/main.js"></script>`,
      sriByPathname,
      new Set(),
      "https://cdn.example.com/app/",
      "anonymous",
    );
    const $ = load(html);
    const scripts = $("script");

    expect(scripts.eq(0).attr("integrity")).toBe(integrity);
    expect(scripts.eq(0).attr("crossorigin")).toBe("anonymous");
    for (const index of [1, 2]) {
      expect(scripts.eq(index).attr("integrity")).toBeUndefined();
      expect(scripts.eq(index).attr("crossorigin")).toBeUndefined();
    }
  });

  test("matches either HTTP scheme for a protocol-relative base", () => {
    const html = processHtmlForSri(
      `<script src="http://cdn.example.com/assets/main.js"></script><script src="https://cdn.example.com/assets/main.js"></script><script src="https://third-party.example/assets/main.js"></script>`,
      sriByPathname,
      new Set(),
      "//cdn.example.com/app/",
      "anonymous",
    );
    const $ = load(html);
    const scripts = $("script");

    for (const index of [0, 1]) {
      expect(scripts.eq(index).attr("integrity")).toBe(integrity);
      expect(scripts.eq(index).attr("crossorigin")).toBe("anonymous");
    }
    expect(scripts.eq(2).attr("integrity")).toBeUndefined();
    expect(scripts.eq(2).attr("crossorigin")).toBeUndefined();
  });

  test.each([
    {
      base: "//cdn.example.com:443/",
      expected: [false, true],
    },
    {
      base: "//cdn.example.com:80/",
      expected: [true, false],
    },
  ])("matches protocol-relative base port $base using effective ports", ({
    base,
    expected,
  }) => {
    const html = processHtmlForSri(
      `<script src="http://cdn.example.com/assets/main.js"></script><script src="https://cdn.example.com/assets/main.js"></script>`,
      sriByPathname,
      new Set(),
      base,
    );
    const scripts = load(html)("script");

    for (const index of [0, 1]) {
      expect(scripts.eq(index).attr("integrity")).toBe(
        expected[index] ? integrity : undefined,
      );
    }
  });

  test("continues matching relative URLs for a relative base", () => {
    const html = processHtmlForSri(
      `<script src="./assets/main.js"></script>`,
      sriByPathname,
      new Set(),
      "./",
      "anonymous",
      [],
      false,
      undefined,
      "index.html",
    );
    const $ = load(html);

    expect($("script").attr("integrity")).toBe(integrity);
    expect($("script").attr("crossorigin")).toBe("anonymous");
  });
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
  await writeFile(path.join(fixtureDir, "src/main.js"), "window.encodedEntry = true;");

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
  const entryName = assets.find((name) => name.startsWith("café-") && name.endsWith(".js"));
  expect(entryName).toBeDefined();
  const entryCode = await readFile(path.join(outDir, "assets", entryName!), "utf8");
  const html = await readFile(path.join(outDir, "index.html"), "utf8");
  const $ = load(html);
  const entryScript = $("script[type='module'][src]").first();
  const expectedIntegrity = `sha256-${createHash("sha256").update(entryCode).digest("base64")}`;

  expect(entryScript.attr("src")).toBe(`/assets/${entryName}`);
  expect(entryScript.attr("integrity")).toBe(expectedIntegrity);
});

test("runtime injection includes a full-URL asset base", async () => {
  const tempDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "csp-guard-asset-base-")),
  );
  tempDirectories.push(tempDir);
  const fixtureDir = path.join(tempDir, "fixture");
  const outDir = path.join(tempDir, "dist");
  const base = "https://cdn.example.com/app/";
  await mkdir(path.join(fixtureDir, "src"), { recursive: true });
  await writeFile(
    path.join(fixtureDir, "index.html"),
    '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
  );
  await writeFile(path.join(fixtureDir, "src/main.js"), "window.assetBaseTest = true;");

  await build({
    configFile: false,
    root: fixtureDir,
    base,
    logLevel: "silent",
    plugins: [vitePluginCSP({ build: { sri: true } })],
    build: { outDir, emptyOutDir: true },
  });

  const assetDirectory = path.join(outDir, "assets");
  const entryName = (await readdir(assetDirectory)).find((name) => name.endsWith(".js"));
  expect(entryName).toBeDefined();
  const entryCode = await readFile(path.join(assetDirectory, entryName!), "utf8");
  expect(entryCode).toContain(`assetBase:${JSON.stringify(base)}`);
});

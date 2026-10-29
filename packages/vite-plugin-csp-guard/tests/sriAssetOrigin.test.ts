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

const integrity = "sha256-local-bundle";
const sriByPathname = { "/assets/main.js": integrity };

describe("processHtmlForSri asset-origin matching", () => {
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
      `<script src="https://cdn.example.com/app/assets/main.js"></script><script src="https://third-party.example/assets/main.js"></script><script src="/assets/main.js"></script>`,
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
      `<script src="http://cdn.example.com/app/assets/main.js"></script><script src="https://cdn.example.com/app/assets/main.js"></script><script src="https://third-party.example/assets/main.js"></script>`,
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

import {
  mkdtemp,
  mkdir,
  readFile,
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

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.each(["./", "", "/", "/app/"])("SRI with base %j", (base) => {
  test("uses the expected HTML-relative or absolute preload paths", async () => {
    const tempDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "csp-guard-relative-base-")),
    );
    tempDirectories.push(tempDir);
    const fixtureDir = path.join(tempDir, "fixture");
    const outDir = path.join(tempDir, "dist");
    await mkdir(path.join(fixtureDir, "src"), { recursive: true });
    await mkdir(path.join(fixtureDir, "sub"), { recursive: true });

    await writeFile(
      path.join(fixtureDir, "index.html"),
      '<!doctype html><html><head></head><body><script type="module" src="/src/root-entry.js"></script></body></html>',
    );
    await writeFile(
      path.join(fixtureDir, "sub/index.html"),
      '<!doctype html><html><head></head><body><script type="module" src="/src/sub-entry.js"></script></body></html>',
    );
    await writeFile(
      path.join(fixtureDir, "src/root-entry.js"),
      'import("./root-lazy.js");',
    );
    await writeFile(
      path.join(fixtureDir, "src/sub-entry.js"),
      'import("./sub-lazy.js");',
    );
    await writeFile(
      path.join(fixtureDir, "src/root-lazy.js"),
      'import "./root-lazy.css"; export const rootLazy = true;',
    );
    await writeFile(
      path.join(fixtureDir, "src/sub-lazy.js"),
      'import "./sub-lazy.css"; export const subLazy = true;',
    );
    await writeFile(
      path.join(fixtureDir, "src/root-lazy.css"),
      "body { color: red; }",
    );
    await writeFile(
      path.join(fixtureDir, "src/sub-lazy.css"),
      "body { color: blue; }",
    );

    await build({
      configFile: false,
      root: fixtureDir,
      base,
      logLevel: "silent",
      plugins: [
        vitePluginCSP({
          build: {
            sri: {
              runtimePatchDynamicLinks: true,
              preloadDynamicChunks: true,
            },
          },
        }),
      ],
      build: {
        outDir,
        emptyOutDir: true,
        rolldownOptions: {
          input: {
            root: "index.html",
            sub: "sub/index.html",
          },
        },
      },
    });

    const relativeBase = base === "./" || base === "";
    const absoluteBase = base.replace(/\/+$/, "");
    const expectedAbsolutePrefix = `${absoluteBase}/assets/`;
    const entryFiles = new Set<string>();
    for (const [htmlFile, relativePrefix] of [
      ["index.html", "./assets/"],
      ["sub/index.html", "../assets/"],
    ] as const) {
      const expectedPrefix = relativeBase
        ? relativePrefix
        : expectedAbsolutePrefix;
      const html = await readFile(path.join(outDir, htmlFile), "utf8");
      const $ = load(html);
      const preloadHrefs = $("link[rel='modulepreload']")
        .map((_, element) => $(element).attr("href"))
        .get();

      expect(
        preloadHrefs.length,
        `${htmlFile} should have dynamic preloads`,
      ).toBeGreaterThan(0);
      expect(
        new Set(preloadHrefs).size,
        `${htmlFile} should not have duplicate preloads`,
      ).toBe(preloadHrefs.length);
      for (const href of preloadHrefs) {
        expect(href).toMatch(
          new RegExp(`^${expectedPrefix.replaceAll(".", "\\.")}`),
        );
        const integrity = $(`link[rel='modulepreload'][href="${href}"]`).attr(
          "integrity",
        );
        if (base !== "/app/") expect(integrity).toMatch(/^sha256-/);
      }

      const entryScript = $("script[type='module'][src]").first();
      const scriptSrc = entryScript.attr("src");
      expect(scriptSrc).toBeTruthy();
      if (base !== "/app/") {
        expect(entryScript.attr("integrity")).toMatch(/^sha256-/);
      }
      const htmlUrl = new URL(htmlFile, "http://localhost/");
      const entryPathname = new URL(scriptSrc!, htmlUrl).pathname;
      const deploymentRoot = new URL(base || "./", "http://localhost/")
        .pathname;
      const entryFile = path.posix.normalize(
        path.posix.relative(deploymentRoot, entryPathname),
      );
      entryFiles.add(entryFile);
      const entryCode = await readFile(path.join(outDir, entryFile), "utf8");
      expect(entryCode).not.toContain("vite-plugin-csp-guard.sri");

      const bootstrapScript = $("script[defer][integrity]").first();
      const bootstrapHref = bootstrapScript.attr("src");
      expect(bootstrapHref).toBeTruthy();
      expect(bootstrapHref).toMatch(
        new RegExp(`^${expectedPrefix.replaceAll(".", "\\.")}csp-guard-sri-`),
      );
      const bootstrapFile = path.posix.join(
        "assets",
        bootstrapHref!.split("/").pop()!,
      );
      const bootstrapCode = await readFile(
        path.join(outDir, bootstrapFile),
        "utf8",
      );
      if (relativeBase) {
        expect(bootstrapCode).toContain(
          'root:new URL("../",(document.currentScript && document.currentScript.src) || document.baseURI).href',
        );
      }
    }
    expect(entryFiles.size).toBe(2);
  });
});

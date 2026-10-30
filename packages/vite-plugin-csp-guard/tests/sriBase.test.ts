import * as cheerio from "cheerio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build, type Rolldown } from "vite";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vitePluginCSP from "../src/index";
import { generateHash } from "../src/policy/core";
import { withBasePathname } from "../src/sri";

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "csp-guard-base-")));
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><html><head></head><body>" +
      '<script type="module" src="./main.js"></script></body></html>',
  );
  await writeFile(
    join(root, "main.js"),
    "import './main.css'\nwindow.load = () => import('./page.js')\n",
  );
  await writeFile(join(root, "main.css"), ".main { color: red; }\n");
  await writeFile(join(root, "page.js"), "export default 1\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const integrity = (source: string) =>
  `sha256-${generateHash(source, "sha256")}`;

describe("withBasePathname", () => {
  test.each([
    ["/app/", "/app"],
    ["/app", "/app"],
    ["https://cdn.example.com/app/", "/app"],
    ["/", ""],
    ["./", ""],
  ])("uses the pathname for base %s", (base, prefix) => {
    expect(
      withBasePathname({ "/assets/main.js": "hash" }, base),
    ).toEqual({ [`${prefix}/assets/main.js`]: "hash" });
  });
});

describe("SRI with a non-root base", () => {
  test.each([
    "/app/",
    "/app",
    "https://cdn.example.com/app/",
    "/",
  ])("adds SRI for base %s", async (base) => {
    const result = await build({
      configFile: false,
      root,
      base,
      logLevel: "silent",
      plugins: [
        vitePluginCSP({ algorithm: "sha256", build: { sri: true } }),
      ],
      build: { write: false, minify: false },
    });
    const output = (Array.isArray(result) ? result[0] : result) as
      Rolldown.RolldownOutput;
    const chunks = output.output.filter(
      (item): item is Rolldown.OutputChunk => item.type === "chunk",
    );
    const entry = chunks.find((chunk) => chunk.isEntry)!;
    const lazy = chunks.find((chunk) =>
      chunk.facadeModuleId?.endsWith("/page.js"),
    )!;
    const css = output.output.find(
      (item): item is Rolldown.OutputAsset =>
        item.type === "asset" && item.fileName.endsWith(".css"),
    )!;
    const htmlAsset = output.output.find(
      (item): item is Rolldown.OutputAsset =>
        item.type === "asset" && item.fileName === "index.html",
    )!;
    const $ = cheerio.load(String(htmlAsset.source));
    const assetUrl = (fileName: string) =>
      `${base.endsWith("/") ? base : `${base}/`}${fileName}`;
    const entryUrl = assetUrl(entry.fileName);
    const cssUrl = assetUrl(css.fileName);

    const entryScript = $("script[src]").filter(
      (_, element) => $(element).attr("src") === entryUrl,
    );
    const cssLink = $("link[href]").filter(
      (_, element) => $(element).attr("href") === cssUrl,
    );
    expect(entryScript.attr("integrity")).toBe(integrity(entry.code));
    expect(cssLink.attr("integrity")).toBe(integrity(String(css.source)));

    const basePathname = new URL(base, "http://localhost/").pathname.replace(
      /\/$/,
      "",
    );
    const expectedKey = `${basePathname}/${lazy.fileName}`;
    const expectedPair = `${JSON.stringify(expectedKey)}:${JSON.stringify(
      integrity(lazy.code),
    )}`;
    const bootstrapAsset = output.output.find(
      (item): item is Rolldown.OutputAsset =>
        item.type === "asset" && /csp-guard-sri-.*\.js$/.test(item.fileName),
    );
    expect(bootstrapAsset).toBeDefined();
    const bootstrapCode = String(bootstrapAsset!.source);
    expect(bootstrapCode).toContain(expectedPair);
    expect(entry.code).not.toContain("vite-plugin-csp-guard.sri");
    if (basePathname) {
      expect(bootstrapCode).not.toContain(
        `${JSON.stringify(`/${lazy.fileName}`)}:`,
      );
    }
  }, 30000);
});

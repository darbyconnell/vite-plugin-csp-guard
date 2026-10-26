import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build, type Rolldown } from "vite";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cheerio from "cheerio";
import vitePluginCSP from "../src/index";
import { generateHash } from "../src/policy/core";

describe("sri.skipResources", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "csp-guard-skip-")));
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>',
    );
    await writeFile(join(root, "main.js"), "window.load = true\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function buildHtml(skipResources: string[]) {
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [
        vitePluginCSP({
          algorithm: "sha256",
          build: { sri: { skipResources, crossorigin: "anonymous" } },
        }),
      ],
      build: {
        write: false,
        minify: false,
        rolldownOptions: { output: { entryFileNames: "assets/entry.js" } },
      },
    });
    const output = (
      Array.isArray(result) ? result[0] : result
    ) as Rolldown.RolldownOutput;
    const entry = output.output.find(
      (item): item is Rolldown.OutputChunk =>
        item.type === "chunk" && item.isEntry,
    )!;
    const htmlAsset = output.output.find(
      (item) => item.fileName === "index.html",
    );
    const html = String((htmlAsset as Rolldown.OutputAsset).source);

    return { entry, html };
  }

  test("adds final integrity when the resource is not skipped", async () => {
    const { entry, html } = await buildHtml([]);
    const script = cheerio.load(html)('script[src="/assets/entry.js"]');

    expect(script).toHaveLength(1);
    expect(script.attr("integrity")).toBe(
      `sha256-${generateHash(entry.code, "sha256")}`,
    );
    expect(script.attr("crossorigin")).toBe("anonymous");
  }, 30000);

  test("leaves integrity off resources matched by skipResources", async () => {
    const { html } = await buildHtml(["/assets/entry.js"]);
    const script = cheerio.load(html)('script[src="/assets/entry.js"]');

    expect(script).toHaveLength(1);
    expect(script.attr("integrity")).toBeUndefined();
  }, 30000);
});

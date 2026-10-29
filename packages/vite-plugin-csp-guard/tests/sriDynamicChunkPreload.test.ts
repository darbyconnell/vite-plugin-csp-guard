import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, test } from "vitest";
import vitePluginCSP from "../src";

async function buildHtml(root: string, preloadDynamicChunks?: boolean) {
  const result = await build({
    root,
    logLevel: "silent",
    plugins: [
      vitePluginCSP({
        build: {
          sri:
            preloadDynamicChunks === undefined
              ? true
              : { preloadDynamicChunks },
        },
      }),
    ],
    build: { write: false, minify: false },
  });

  const results = result ? (Array.isArray(result) ? result : [result]) : [];
  const outputs = results.filter((output) => "output" in output);
  const htmlAsset = outputs
    .flatMap((output) => output.output)
    .find(
      (item) => item.type === "asset" && item.fileName.endsWith("index.html"),
    );

  if (!htmlAsset || htmlAsset.type !== "asset") {
    throw new Error("Vite build did not emit index.html");
  }

  return typeof htmlAsset.source === "string"
    ? htmlAsset.source
    : Buffer.from(htmlAsset.source).toString();
}

describe("SRI dynamic chunk preloads", () => {
  test("can opt out of generated modulepreload links", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-csp-guard-sri-"));

    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "index.html"),
        '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
      );
      await writeFile(
        join(root, "src/main.js"),
        'import("./lazy.js").then(({ value }) => { document.body.dataset.value = value; });',
      );
      await writeFile(
        join(root, "src/lazy.js"),
        'export const value = "lazy";',
      );

      const defaultHtml = await buildHtml(root);
      expect(defaultHtml).toMatch(
        /<link\b(?=[^>]*\brel="modulepreload")(?=[^>]*\bintegrity="sha256-[^"]+")[^>]*>/,
      );

      const optOutHtml = await buildHtml(root, false);
      expect(optOutHtml).not.toMatch(
        /<link\b(?=[^>]*\brel="modulepreload")(?=[^>]*\bintegrity="sha256-[^"]+")[^>]*>/,
      );
      expect(optOutHtml).toMatch(
        /<script\b(?=[^>]*\bintegrity="sha256-[^"]+")[^>]*>/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

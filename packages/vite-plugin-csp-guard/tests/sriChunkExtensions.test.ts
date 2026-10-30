import { createHash } from "crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import * as path from "path";
import { build } from "vite";
import type { OutputBundle } from "rollup";
import { describe, expect, test } from "vitest";
import vitePluginCSP from "../src";
import { buildIntegrityMappings } from "../src/sri";

const sha256 = (source: string | Uint8Array) =>
  `sha256-${createHash("sha256").update(source).digest("base64")}`;

describe("SRI chunk extension hashing", () => {
  test.each(["x.chunk", "x.cjs"])(
    "buildIntegrityMappings hashes chunk %s regardless of extension",
    (fileName) => {
      const code = "console.log('chunk');";
      const bundle = {
        [fileName]: {
          type: "chunk" as const,
          fileName,
          code,
          name: "x",
          isEntry: true,
          isDynamicEntry: false,
          facadeModuleId: null,
          moduleIds: [],
          exports: [],
          modules: {},
          imports: [],
          dynamicImports: [],
          implicitlyLoadedBefore: [],
          referencedFiles: [],
          preliminaryFileName: fileName,
          sourcemapFileName: null,
        },
      } as unknown as OutputBundle;

      expect(buildIntegrityMappings(bundle, "sha256", false)).toEqual({
        [`/${fileName}`]: sha256(code),
      });
    },
  );

  test("hashes byte assets using their original bytes", () => {
    const source = Uint8Array.from([0x62, 0xff, 0x7d]);
    const bundle = {
      "asset.css": {
        type: "asset" as const,
        fileName: "asset.css",
        source,
      },
    } as unknown as OutputBundle;

    expect(buildIntegrityMappings(bundle, "sha256", false)).toEqual({
      "/asset.css": sha256(source),
    });
  });

  test.each([".chunk", ".cjs"])(
    "adds entry-script integrity to a Vite build with %s output names",
    async (extension) => {
      const root = await mkdtemp(
        path.join(process.cwd(), ".tmp-vite-csp-sri-"),
      );
      const outDir = path.join(root, "dist");

      try {
        await writeFile(
          path.join(root, "index.html"),
          '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
        );
        await mkdir(path.join(root, "src"));
        await writeFile(
          path.join(root, "src/main.js"),
          "console.log('vite SRI test');",
        );

        await build({
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [
            vitePluginCSP({
              build: { sri: { runtimePatchDynamicLinks: false } },
            }),
          ],
          build: {
            outDir,
            emptyOutDir: true,
            minify: false,
            rollupOptions: {
              output: {
                entryFileNames: `assets/[name]${extension}`,
                chunkFileNames: `assets/[name]${extension}`,
              },
            },
          },
        });

        const html = await readFile(path.join(outDir, "index.html"), "utf8");
        const scriptTag = html.match(
          /<script\b[^>]*\bsrc="([^"]+)"[^>]*>/,
        )?.[0];
        const scriptSrc = scriptTag?.match(/\bsrc="([^"]+)"/)?.[1];
        const integrity = scriptTag?.match(/\bintegrity="([^"]+)"/)?.[1];

        expect(scriptSrc).toBeDefined();
        expect(integrity).toBeDefined();
        const emittedChunk = await readFile(
          path.join(outDir, scriptSrc!.replace(/^\//, "")),
          "utf8",
        );
        expect(integrity).toBe(sha256(emittedChunk));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { definePolicy, self, unsafeInline } from "csp-toolkit";
import { build } from "vite";
import { afterEach, describe, expect, test } from "vitest";
import vitePluginCSP from "../src/index";
import { createNewCollection, generateHash } from "../src/policy/core";
import { handleIndexHtml } from "../src/transform/handleIndexHtml";

const buildRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    buildRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("inline style hashing", () => {
  test("adds an inline style hash to style-src-elem without normalizing its text", () => {
    const collection = createNewCollection();
    const styleText = "\n  body { color: red; }\n";

    handleIndexHtml({
      html: `<html><head><style>${styleText}</style></head></html>`,
      algorithm: "sha256",
      collection,
      policy: {},
      context: undefined,
    });

    const hash = generateHash(styleText, "sha256");
    expect(collection["style-src-elem"].get(`sha256-${hash}`)).toEqual({
      algorithm: "sha256",
      content: styleText,
    });
  });

  test("ignores empty style elements", () => {
    const collection = createNewCollection();

    handleIndexHtml({
      html: "<html><head><style></style></head></html>",
      algorithm: "sha256",
      collection,
      policy: {},
      context: undefined,
    });

    expect(collection["style-src-elem"].size).toBe(0);
  });

  test("hashes each of multiple inline style elements", () => {
    const collection = createNewCollection();
    const styleTexts = ["body{color:red}", "p{color:blue}"];

    handleIndexHtml({
      html: `<html><head>${styleTexts.map((text) => `<style>${text}</style>`).join("")}</head></html>`,
      algorithm: "sha256",
      collection,
      policy: {},
      context: undefined,
    });

    expect(collection["style-src-elem"].size).toBe(2);
    for (const content of styleTexts) {
      const hash = generateHash(content, "sha256");
      expect(collection["style-src-elem"].get(`sha256-${hash}`)).toEqual({
        algorithm: "sha256",
        content,
      });
    }
  });

  test("includes inline style hashes in the built CSP meta and omits them for unsafe-inline", async () => {
    const styleText = "body{color:red}";

    const buildHtml = async (policy: ReturnType<typeof definePolicy>) => {
      const root = await mkdtemp(path.join(tmpdir(), "csp-inline-style-"));
      buildRoots.push(root);
      const buildRoot = await realpath(root);
      await writeFile(
        path.join(buildRoot, "index.html"),
        `<!doctype html><html><head><style>${styleText}</style></head><body></body></html>`,
      );

      await build({
        configFile: false,
        root: buildRoot,
        logLevel: "silent",
        plugins: [vitePluginCSP({ policy })],
        build: { outDir: "dist" },
      });

      const html = await readFile(
        path.join(buildRoot, "dist", "index.html"),
        "utf8",
      );
      const $ = cheerio.load(html);
      return $("meta[http-equiv='Content-Security-Policy']").attr("content") ?? "";
    };

    const allowedPolicy = await buildHtml(
      definePolicy({ styleSrcElem: [self] }),
    );
    const styleDirective = allowedPolicy
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("style-src-elem "));
    expect(styleDirective).toContain(
      `sha256-${generateHash(styleText, "sha256")}`,
    );

    const unsafeInlinePolicy = await buildHtml(
      definePolicy({ styleSrcElem: [self, unsafeInline] }),
    );
    const unsafeInlineDirective = unsafeInlinePolicy
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("style-src-elem "));
    expect(unsafeInlineDirective).toContain("'unsafe-inline'");
    expect(unsafeInlineDirective).not.toContain(
      `sha256-${generateHash(styleText, "sha256")}`,
    );
  });
});

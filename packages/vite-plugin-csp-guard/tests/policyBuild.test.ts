import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { afterEach, describe, expect, test } from "vitest";
import { definePolicy, self, unsafeInline } from "csp-toolkit";
import vitePluginCSP from "../src";
import type { MyPluginOptions } from "../src/types";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function buildHtml(
  policy: MyPluginOptions["policy"],
  body = "<script>window.__appRan = true;</script>",
  override = true,
) {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp-csp-policy-build-"));
  tempDirectories.push(root);
  await writeFile(
    path.join(root, "index.html"),
    `<!doctype html><html><head></head><body>${body}</body></html>`,
  );

  await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [vitePluginCSP({ policy, override })],
    build: {
      outDir: path.join(root, "dist"),
      emptyOutDir: true,
    },
  });

  return readFile(path.join(root, "dist", "index.html"), "utf8");
}

function directiveSources(html: string, directive: string) {
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  expect(policy).toBeDefined();
  const entry = policy!.split(";").map((part) => part.trim()).find((part) =>
    part.startsWith(`${directive} `),
  );
  return entry ? entry.slice(directive.length + 1).split(/\s+/) : [];
}

describe("Vite build policy generation", () => {
  test("uses default-src fallback when override has no script-src directives", async () => {
    const html = await buildHtml(
      definePolicy({
        defaultSrc: [self, "https://fallback.example"],
      }),
    );

    const sources = directiveSources(html, "script-src-elem");
    expect(sources).toContain("'self'");
    expect(sources).toContain("https://fallback.example");
    expect(sources.some((source) => source.startsWith("'sha256-"))).toBe(true);
  });

  test("does not broaden an explicit script-src-elem during a build", async () => {
    const html = await buildHtml(
      definePolicy({
        scriptSrc: ["https://parent-only.example"],
        scriptSrcElem: [self],
      }),
    );

    const sources = directiveSources(html, "script-src-elem");
    expect(sources).toContain("'self'");
    expect(sources.some((source) => source.startsWith("'sha256-"))).toBe(true);
    expect(sources).not.toContain("https://parent-only.example");
  });

  test("preserves inherited unsafe-inline for script elements during a build", async () => {
    const html = await buildHtml(
      definePolicy({
        scriptSrc: [self, unsafeInline],
      }),
      undefined,
      false,
    );

    const sources = directiveSources(html, "script-src-elem");
    expect(sources).toContain("'self'");
    expect(sources).toContain("'unsafe-inline'");
    expect(sources.some((source) => source.startsWith("'sha256-"))).toBe(false);
  });
});

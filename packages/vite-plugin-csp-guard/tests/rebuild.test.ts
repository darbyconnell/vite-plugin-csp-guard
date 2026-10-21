import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build, type Plugin, type Rolldown } from "vite";
import * as cheerio from "cheerio";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vitePluginCSP from "../src/index";

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "csp-guard-rebuild-")));
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>',
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const buildPolicy = async (plugin: Plugin) => {
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [plugin],
    build: { write: false },
  });
  const output = (Array.isArray(result) ? result[0] : result) as Rolldown.RolldownOutput;
  const html = output.output.find((o) => o.fileName === "index.html") as Rolldown.OutputAsset;
  return cheerio
    .load(String(html.source))('meta[http-equiv="Content-Security-Policy"]')
    .attr("content");
};

describe("rebuilds", () => {
  test("a reused plugin instance only lists hashes from the current build", async () => {
    const options = { build: { sri: true } };
    const reused = vitePluginCSP(options);

    await writeFile(join(root, "main.js"), "console.log('first')\n");
    await buildPolicy(reused);

    await writeFile(join(root, "main.js"), "console.log('second')\n");
    const rebuilt = await buildPolicy(reused);
    const fresh = await buildPolicy(vitePluginCSP(options));

    expect(rebuilt).toBe(fresh);
  }, 30000);
});

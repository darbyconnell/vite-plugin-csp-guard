import * as cheerio from "cheerio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build, type Rolldown } from "vite";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vitePluginCSP from "../src/index";
import { generateHash } from "../src/policy/core";
import { PENDING_POLICY_ATTR } from "../src/transform";
import type { MyPluginOptions } from "../src/types";

async function writeFixture(root: string) {
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>',
  );
  await writeFile(
    join(root, "main.js"),
    "window.load = () => import('./page.js')\nwindow.loadShared = () => import('./shared.js')\n",
  );
  await writeFile(
    join(root, "page.js"),
    "import './page.css'\nimport { shared } from './shared.js'\nexport const loadDeep = () => import('./deep.js')\nexport default shared\n",
  );
  await writeFile(join(root, "page.css"), ".page { color: red; }\n");
  await writeFile(join(root, "shared.js"), "export const shared = 42\n");
  await writeFile(
    join(root, "deep.js"),
    "import './deep.css'\nexport default 1\n",
  );
  await writeFile(join(root, "deep.css"), ".deep { color: blue; }\n");
}

async function buildFixture(root: string, options: MyPluginOptions) {
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [vitePluginCSP(options)],
    build: {
      write: false,
      minify: false,
      assetsDir: "assets",
    },
  });
  const output = (
    Array.isArray(result) ? result[0] : result
  ) as Rolldown.RolldownOutput;
  const chunks = output.output.filter(
    (item): item is Rolldown.OutputChunk => item.type === "chunk",
  );
  const html = output.output.find(
    (item) => item.fileName === "index.html",
  ) as Rolldown.OutputAsset;
  const entry = chunks.find((chunk) => chunk.isEntry)!;
  const htmlSource = String(html.source);
  const $ = cheerio.load(htmlSource);
  const csp = $('meta[http-equiv="Content-Security-Policy"]').attr("content");
  const finalHashes = chunks.map(
    (chunk) => `sha256-${generateHash(chunk.code, "sha256")}`,
  );
  return {
    chunks,
    entry,
    html: htmlSource,
    csp,
    finalHashes,
    output: output.output,
    $,
  };
}

function scriptElemHashes(csp: string | undefined): string[] {
  const directive = csp
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("script-src-elem "));
  return (directive?.match(/'sha256-[^']+'/g) ?? []).map((source) =>
    source.slice(1, -1),
  );
}

describe("transformPolicy with SRI", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "csp-guard-policy-")));
    await writeFixture(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test.each([
    ["runtime", true],
    ["no runtime", { runtimePatchDynamicLinks: false }],
  ] as const)(
    "%s receives final hashes and can remove the meta tag",
    async (_name, sri) => {
      const received: string[] = [];
      const result = await buildFixture(root, {
        algorithm: "sha256",
        build: { sri },
        transformPolicy: (policy, meta) => {
          expect(meta.command).toBe("build");
          received.push(policy);
          return null;
        },
      });
      expect(received).toHaveLength(1);
      for (const hash of result.finalHashes) {
        expect(received[0]).toContain(`'${hash}'`);
      }
      expect(
        scriptElemHashes(received[0]).filter(
          (hash) => !result.finalHashes.includes(hash),
        ),
      ).toEqual([]);
      expect(
        result.$('meta[http-equiv="Content-Security-Policy"]').length,
      ).toBe(0);
      expect(result.$(`[${PENDING_POLICY_ATTR}]`).length).toBe(0);
    },
    30000,
  );

  test("a string replaces the policy and undefined keeps it", async () => {
    let customPolicy = "";
    const custom = await buildFixture(root, {
      build: { sri: true },
      transformPolicy: (policy) => {
        customPolicy = policy;
        return "default-src 'none'";
      },
    });
    expect(custom.csp).toBe("default-src 'none'");
    for (const hash of custom.finalHashes) {
      expect(customPolicy).toContain(`'${hash}'`);
    }
    expect(custom.$(`[${PENDING_POLICY_ATTR}]`).length).toBe(0);

    let originalPolicy = "";
    const kept = await buildFixture(root, {
      build: { sri: true },
      transformPolicy: (policy) => {
        originalPolicy = policy;
        return undefined;
      },
    });
    expect(kept.csp).toBe(originalPolicy);
    for (const hash of kept.finalHashes) {
      expect(originalPolicy).toContain(`'${hash}'`);
    }
    expect(kept.$(`[${PENDING_POLICY_ATTR}]`).length).toBe(0);
  }, 30000);

  test("preserves entity-like report-uri text with and without SRI", async () => {
    const reportUri = "https://example.test/csp?value=&lt";
    const policy = { "report-uri": [reportUri] };
    const sriPolicies: string[] = [];
    const plainPolicies: string[] = [];
    const makeOptions = (sri: boolean, received: string[]) => ({
      policy,
      build: { sri },
      transformPolicy: (value: string) => {
        received.push(value);
        return undefined;
      },
    });

    await buildFixture(root, makeOptions(true, sriPolicies));
    await buildFixture(root, makeOptions(false, plainPolicies));

    const reportDirective = (value: string) =>
      value
        .split(";")
        .find((directive) => directive.trim().startsWith("report-uri"));
    expect(reportDirective(sriPolicies[0]!)).toBe(
      reportDirective(plainPolicies[0]!),
    );
    expect(reportDirective(sriPolicies[0]!)).toContain(reportUri);
  }, 30000);

  test("propagates transformPolicy errors without relabeling them", async () => {
    const error = await buildFixture(root, {
      build: { sri: true },
      transformPolicy: () => {
        throw new Error("transformPolicy callback failed");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "transformPolicy callback failed",
    );
    expect((error as Error).message).not.toContain("SRI processing failed");
  }, 30000);
});

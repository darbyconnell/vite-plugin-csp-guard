import * as cheerio from "cheerio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build, type Rolldown } from "vite";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vitePluginCSP from "../src/index";
import { generateHash } from "../src/policy/core";
import { processHtmlForSri } from "../src/sri/processHtml";
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

async function buildFixture(
  root: string,
  options: MyPluginOptions | null,
  config: {
    base?: string;
    entryFileNames?: string;
    input?: Record<string, string>;
    library?: boolean;
  } = {},
) {
  const result = await build({
    configFile: false,
    root,
    base: config.base,
    logLevel: "silent",
    plugins: options ? [vitePluginCSP(options)] : [],
    build: {
      write: false,
      minify: false,
      assetsDir: "assets",
      ...(config.library
        ? { lib: { entry: join(root, "main.js"), formats: ["es"] as const } }
        : {}),
      ...(config.entryFileNames || config.input
        ? {
            rolldownOptions: {
              ...(config.entryFileNames
                ? { output: { entryFileNames: config.entryFileNames } }
                : {}),
              ...(config.input ? { input: config.input } : {}),
            },
          }
        : {}),
    },
  });
  const output = (
    Array.isArray(result) ? result[0] : result
  ) as Rolldown.RolldownOutput;
  const chunks = output.output.filter(
    (item): item is Rolldown.OutputChunk => item.type === "chunk",
  );
  const html = output.output.find((item) => item.fileName.endsWith(".html")) as
    | Rolldown.OutputAsset
    | undefined;
  const entry = chunks.find((chunk) => chunk.isEntry)!;
  const htmlSource = String(html?.source ?? "");
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

type FixtureBuild = Awaited<ReturnType<typeof buildFixture>>;

function chunkNames(result: FixtureBuild): Record<string, string> {
  return Object.fromEntries(
    result.chunks.map((chunk) => [chunk.name, chunk.fileName]),
  );
}

function runtimeMapPair(fileName: string, integrity: string): string {
  return `${JSON.stringify(`/${fileName}`)}:${JSON.stringify(integrity)}`;
}

function runtimeMapKey(fileName: string): string {
  return `${JSON.stringify(`/${fileName}`)}:`;
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

describe("dynamic import preload lists", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "csp-guard-preload-")));
    await writeFixture(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const variants: Array<[string, MyPluginOptions]> = [
    ["sri", { build: { sri: true } }],
    [
      "sri + vue-router outlier",
      { build: { sri: true, outlierSupport: ["vue-router"] } },
    ],
    [
      "sri without runtime",
      { build: { sri: { runtimePatchDynamicLinks: false } } },
    ],
  ];

  test.each(variants)(
    "%s: keeps preload lists and hashes the code that is written",
    async (_name, options) => {
      const result = await buildFixture(root, {
        algorithm: "sha256",
        policy: { "script-src": ["'strict-dynamic'"] },
        ...options,
      });
      // page.js lazy-imports deep.js, so deep's CSS is named only in page's
      // preload list (the entry also carries the SRI runtime's file map).
      const page = result.chunks.find((chunk) => chunk.name === "page")!;
      const deepCss = result.output.find(
        (item) => item.type === "asset" && /deep-.*\.css$/.test(item.fileName),
      )!;

      for (const chunk of result.chunks) {
        expect(chunk.code).not.toContain("__VITE_PRELOAD__");
      }
      expect(page.code).toContain(deepCss.fileName);

      expect(result.csp).toBeDefined();
      for (const hash of result.finalHashes) {
        expect(result.csp).toContain(`'${hash}'`);
      }
      expect([...new Set(scriptElemHashes(result.csp))].sort()).toEqual(
        [...new Set(result.finalHashes)].sort(),
      );
      const entryHash = `sha256-${generateHash(result.entry.code, "sha256")}`;
      const entryScript = result
        .$("script[src]")
        .filter(
          (_, element) =>
            result.$(element).attr("src")?.endsWith(result.entry.fileName) ??
            false,
        );
      expect(entryScript.attr("integrity")).toBe(entryHash);
    },
    30000,
  );

  test("custom chunk extensions are replaced with their final code hash", async () => {
    const result = await buildFixture(
      root,
      {
        algorithm: "sha256",
        policy: { "script-src": ["'strict-dynamic'"] },
        build: { sri: { runtimePatchDynamicLinks: false } },
      },
      { entryFileNames: "assets/[name]-[hash].chunk" },
    );
    const entryHash = `sha256-${generateHash(result.entry.code, "sha256")}`;

    expect(result.entry.fileName).toMatch(/\.chunk$/);
    expect(result.csp).toContain(`'${entryHash}'`);
    expect(scriptElemHashes(result.csp)).toContain(entryHash);
  }, 30000);
});

describe("entry SRI runtime maps", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "csp-guard-map-")));
    await writeFixture(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reachable maps use final integrities and exclude the entry", async () => {
    const result = await buildFixture(root, {
      algorithm: "sha256",
      build: { sri: true },
    });
    expect(result.entry.code).not.toContain(
      runtimeMapKey(result.entry.fileName),
    );

    for (const chunk of result.chunks.filter((item) => !item.isEntry)) {
      expect(result.entry.code).toContain(
        runtimeMapPair(
          chunk.fileName,
          `sha256-${generateHash(chunk.code, "sha256")}`,
        ),
      );
    }
    const cssFiles = result.output.filter(
      (item): item is Rolldown.OutputAsset =>
        item.type === "asset" && item.fileName.endsWith(".css"),
    );
    expect(cssFiles.length).toBeGreaterThan(0);
    for (const css of cssFiles) {
      expect(result.entry.code).toContain(
        runtimeMapPair(
          css.fileName,
          `sha256-${generateHash(String(css.source), "sha256")}`,
        ),
      );
    }
  }, 30000);

  test.each(["direct", "nested"] as const)(
    "includes final CSS integrity for a %s CSS-only lazy import",
    async (shape) => {
      const cssRoot = await realpath(
        await mkdtemp(join(tmpdir(), "csp-guard-css-lazy-")),
      );
      try {
        await writeFile(
          join(cssRoot, "index.html"),
          "<!doctype html><html><head></head><body>" +
            '<script type="module" src="./main.js"></script></body></html>',
        );
        if (shape === "direct") {
          await writeFile(
            join(cssRoot, "main.js"),
            "window.load = () => import('./theme.css')\n",
          );
        } else {
          await writeFile(
            join(cssRoot, "main.js"),
            "window.load = () => import('./lazy.js')\n",
          );
          await writeFile(
            join(cssRoot, "lazy.js"),
            "window.loadTheme = () => import('./theme.css')\n",
          );
        }
        await writeFile(join(cssRoot, "theme.css"), ".theme { color: red; }\n");

        const result = await buildFixture(cssRoot, {
          algorithm: "sha256",
          build: { sri: true },
        });
        const css = result.output.find(
          (item): item is Rolldown.OutputAsset =>
            item.type === "asset" && item.fileName.endsWith(".css"),
        );
        expect(css).toBeDefined();
        expect(result.entry.code).toContain(
          runtimeMapPair(
            css!.fileName,
            `sha256-${generateHash(String(css!.source), "sha256")}`,
          ),
        );
        expect(result.entry.code).not.toContain(
          runtimeMapKey(result.entry.fileName),
        );
      } finally {
        await rm(cssRoot, { recursive: true, force: true });
      }
    },
    30000,
  );
});

describe("multi-page entry SRI runtime maps", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "csp-guard-mpa-")));
    for (const page of ["a", "b"]) {
      await writeFile(
        join(root, `${page}.html`),
        `<!doctype html><html><head></head><body>` +
          `<script type="module" src="./${page}.js"></script></body></html>`,
      );
    }
    await writeFile(
      join(root, "a.js"),
      "window.a = () => import('./a-lazy.js')\n",
    );
    await writeFile(join(root, "a-lazy.js"), "export default 'a'\n");
    await writeFile(
      join(root, "b.js"),
      "window.b = () => import('./b-lazy.js')\n",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("page b changes do not affect page a's map or name", async () => {
    const input = { a: join(root, "a.html"), b: join(root, "b.html") };
    const options: MyPluginOptions = {
      algorithm: "sha256",
      build: { sri: true },
    };
    const entries = () =>
      buildFixture(root, options, { input }).then(({ chunks }) => chunks);

    await writeFile(join(root, "b-lazy.js"), "export default 'b1'\n");
    const first = await entries();
    const firstA = first.find((chunk) => chunk.isEntry && chunk.name === "a")!;
    const firstB = first.find((chunk) => chunk.isEntry && chunk.name === "b")!;
    const bLazy = first.find((chunk) => chunk.name === "b-lazy")!;
    expect(firstA.code).not.toContain(runtimeMapKey(bLazy.fileName));
    expect(firstB.code).toContain(
      runtimeMapPair(
        bLazy.fileName,
        `sha256-${generateHash(bLazy.code, "sha256")}`,
      ),
    );

    await writeFile(join(root, "b-lazy.js"), "export default 'b2'\n");
    const second = await entries();
    const secondA = second.find(
      (chunk) => chunk.isEntry && chunk.name === "a",
    )!;
    const secondB = second.find(
      (chunk) => chunk.isEntry && chunk.name === "b",
    )!;

    expect(secondA.fileName).toBe(firstA.fileName);
    expect(secondA.code).toBe(firstA.code);
    expect(secondB.fileName).not.toBe(firstB.fileName);
  }, 30000);
});

describe("SRI chunk file names", () => {
  let root: string;
  let plain: FixtureBuild;
  let sri: FixtureBuild;
  let sriRepeat: FixtureBuild;
  let sriCrossorigin: FixtureBuild;
  let sriSha384: FixtureBuild;
  let noSri: FixtureBuild;
  let skipInline: FixtureBuild;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "csp-guard-names-")));
    await writeFixture(root);
    plain = await buildFixture(root, null);
    sri = await buildFixture(root, { build: { sri: true } });
    sriRepeat = await buildFixture(root, { build: { sri: true } });
    sriCrossorigin = await buildFixture(root, {
      build: { sri: { crossorigin: "anonymous" } },
    });
    sriSha384 = await buildFixture(root, {
      algorithm: "sha384",
      build: { sri: true },
    });
    noSri = await buildFixture(root, { build: { sri: false } });
    skipInline = await buildFixture(root, {
      policy: { "script-src-elem": ["'unsafe-inline'"] },
      build: { sri: { runtimePatchDynamicLinks: false } },
    });
  }, 30000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("relative bases produce distinct entry names deterministically", async () => {
    const baseRoot = await realpath(
      await mkdtemp(join(tmpdir(), "csp-guard-base-names-")),
    );
    try {
      await writeFile(
        join(baseRoot, "main.js"),
        "window.load = (path) => import(path)\n",
      );
      await writeFile(join(baseRoot, "lazy.js"), "export default 42\n");

      const sriOptions: MyPluginOptions = { build: { sri: true } };
      const absoluteBase = await buildFixture(baseRoot, sriOptions, {
        base: "/",
        entryFileNames: "assets/[name]-[hash].js",
        library: true,
      });
      const relativeBase = await buildFixture(baseRoot, sriOptions, {
        base: "./",
        entryFileNames: "assets/[name]-[hash].js",
        library: true,
      });
      const relativeBaseRepeat = await buildFixture(baseRoot, sriOptions, {
        base: "./",
        entryFileNames: "assets/[name]-[hash].js",
        library: true,
      });

      expect(absoluteBase.entry.code).toContain("import(path)");
      expect(absoluteBase.entry.fileName).not.toBe(relativeBase.entry.fileName);
      expect(relativeBaseRepeat.entry.fileName).toBe(
        relativeBase.entry.fileName,
      );
    } finally {
      await rm(baseRoot, { recursive: true, force: true });
    }
  }, 30000);

  test("same config builds produce identical names", () => {
    expect(chunkNames(sriRepeat)).toEqual(chunkNames(sri));
  });

  test("different runtime options rename the entry", () => {
    expect(sriCrossorigin.entry.code).not.toEqual(sri.entry.code);
    expect(sriCrossorigin.entry.fileName).not.toEqual(sri.entry.fileName);
  });

  test("a different hash algorithm renames the entry", () => {
    expect(sriSha384.entry.code).not.toEqual(sri.entry.code);
    expect(sriSha384.entry.fileName).not.toEqual(sri.entry.fileName);
  });

  test("only chunks changed by SRI are renamed", () => {
    for (const chunk of plain.chunks) {
      const sriChunk = sri.chunks.find((item) => item.name === chunk.name)!;
      const changed = chunk.isEntry || chunk.dynamicImports.length > 0;
      expect(sriChunk.fileName === chunk.fileName).toBe(!changed);
    }
  });

  test("without SRI, names match a build without the plugin", () => {
    expect(chunkNames(noSri)).toEqual(chunkNames(plain));
  });

  test("skipped script hashing does not salt non-entry chunks", () => {
    for (const chunk of plain.chunks.filter((item) => !item.isEntry)) {
      const skippedChunk = skipInline.chunks.find(
        (item) => item.name === chunk.name,
      )!;
      expect(skippedChunk.fileName).toBe(chunk.fileName);
    }
  });
});

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
      const page = result.chunks.find((chunk) => chunk.name === "page")!;
      const deepCss = result.output.find(
        (item) => item.type === "asset" && /deep-.*\.css$/.test(item.fileName),
      )!;

      expect(page.code).not.toContain("__VITE_PRELOAD__");
      expect(page.code).toContain(deepCss.fileName);
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

describe("processHtmlForSri hash replacements", () => {
  test("uses a single replacement pass and preserves unchanged shared hashes", () => {
    const html = processHtmlForSri(
      "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src-elem 'A' 'B'\">",
      {},
      new Set(),
      "/",
      undefined,
      [],
      false,
      [
        { old: "A", new: "B" },
        { old: "A", new: "A" },
        { old: "B", new: "C" },
      ],
    );
    const $ = cheerio.load(html);

    expect(
      $('meta[http-equiv="Content-Security-Policy"]').attr("content"),
    ).toBe("script-src-elem 'B' 'A' 'C'");
  });
});

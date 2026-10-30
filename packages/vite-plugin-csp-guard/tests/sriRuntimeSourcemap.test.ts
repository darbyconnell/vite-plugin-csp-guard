import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { build, type Rolldown } from "vite";
import { describe, expect, test } from "vitest";
import vitePluginCSP from "../src";
import { injectRuntimeAndShiftSourceMaps } from "../src/sri/injectRuntime";

type OutputChunk = Rolldown.OutputChunk;
type OutputAsset = Rolldown.OutputAsset;

const marker = "distinctive-original-statement";

describe("inline source map comment selection", () => {
  test.each(["line", "block"] as const)(
    "shifts only the final inline map comment (%s)",
    (commentType) => {
      const createMapUrl = (mappings: string) =>
        `data:application/json;base64,${Buffer.from(
          JSON.stringify({
            version: 3,
            sources: ["entry.js"],
            names: [],
            mappings,
          }),
        ).toString("base64")}`;
      const decoyUrl = `//# sourceMappingURL=${createMapUrl("AAAA")}`;
      const trailingUrl = createMapUrl("BBBB");
      const trailingComment =
        commentType === "block"
          ? `/*# sourceMappingURL=${trailingUrl} */`
          : `//# sourceMappingURL=${trailingUrl}`;
      const chunk = {
        fileName: "entry.js",
        code: `const decoy = ${JSON.stringify(decoyUrl)};\n${trailingComment}\n \t`,
        map: null,
      } as unknown as Rolldown.OutputChunk;
      const bundle = {
        "entry.js": chunk,
      } as unknown as Rolldown.OutputBundle;

      injectRuntimeAndShiftSourceMaps(
        chunk as unknown as import("rollup").OutputChunk,
        bundle as unknown as import("rollup").OutputBundle,
        "runtime();\n",
      );

      expect(chunk.code).toContain(
        `const decoy = ${JSON.stringify(decoyUrl)};`,
      );
      const trailingMap = chunk.code.match(
        /data:application\/json;base64,([A-Za-z0-9+/=]+)(?:\s*\*\/)?\s*$/,
      );
      expect(trailingMap).not.toBeNull();
      const shiftedMap = JSON.parse(
        Buffer.from(trailingMap![1]!, "base64").toString("utf8"),
      );
      expect(shiftedMap.mappings).toBe(";BBBB");
    },
  );
});

async function buildFixture(sourcemap: true | "hidden" | "inline") {
  const root = await mkdtemp(join(process.cwd(), ".tmp-csp-sourcemap-"));
  const source = [
    'const first = "first";',
    'const second = "second";',
    `globalThis.sourceMapMarker = "${marker}";`,
    "console.log(globalThis.sourceMapMarker);",
    "",
  ].join("\n");

  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/main.js"), source);

    const result = await build({
      configFile: false,
      logLevel: "silent",
      root,
      plugins: [vitePluginCSP({ build: { sri: true } })],
      build: {
        outDir: "dist",
        sourcemap,
        write: false,
        rolldownOptions: { input: join(root, "src/main.js") },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const output = outputs.flatMap((entry) =>
      "output" in entry ? entry.output : [],
    );
    const chunk = output.find(
      (item): item is OutputChunk => item.type === "chunk" && item.isEntry,
    );
    if (!chunk) throw new Error("Fixture entry output missing");

    let map: Record<string, unknown>;
    if (sourcemap === "inline") {
      const inlineMap = chunk.code.match(
        /\/\/[#@] sourceMappingURL=data:application\/json[^,]*;base64,([^\s]+)/,
      );
      if (!inlineMap) throw new Error("Inline source map missing");
      map = JSON.parse(Buffer.from(inlineMap[1]!, "base64").toString("utf8"));
    } else {
      const mapFileName = chunk.sourcemapFileName ?? `${chunk.fileName}.map`;
      const mapAsset = output.find(
        (item): item is OutputAsset =>
          item.type === "asset" && item.fileName === mapFileName,
      );
      if (!mapAsset)
        throw new Error(`Source map asset missing: ${mapFileName}`);
      const mapSource =
        typeof mapAsset.source === "string"
          ? mapAsset.source
          : Buffer.from(mapAsset.source).toString("utf8");
      map = JSON.parse(mapSource);
    }

    return { chunk, map, source };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("SRI runtime source maps", () => {
  test.each([true, "hidden", "inline"] as const)(
    "preserves entry source maps when a non-HTML runtime import is added (sourcemap=%s)",
    async (sourcemap) => {
      const { chunk, map, source } = await buildFixture(sourcemap);
      const markerIndex = chunk.code.indexOf("globalThis.sourceMapMarker");
      expect(markerIndex).toBeGreaterThanOrEqual(0);

      const generatedBeforeMarker = chunk.code.slice(0, markerIndex);
      const generatedLine = generatedBeforeMarker.split("\n").length;
      const generatedColumn =
        markerIndex - (generatedBeforeMarker.lastIndexOf("\n") + 1);
      const original = originalPositionFor(
        new TraceMap(
          map as unknown as ConstructorParameters<typeof TraceMap>[0],
        ),
        {
          line: generatedLine,
          column: generatedColumn,
        },
      );

      expect(original.source).toBeTruthy();
      expect(String(original.source)).toMatch(/src\/main\.js$/);
      expect(original.line).toBe(3);
      expect(original.column).toBe(0);
      expect(source.split("\n")[original.line! - 1]).toContain(marker);

      expect(chunk.code.split("\n", 1)[0]).toMatch(
        /^import "(?:\.\/|\.\.\/).*csp-guard-sri-module-/,
      );
      expect(chunk.imports.some((fileName) =>
        /csp-guard-sri-module-.*\.js$/.test(fileName),
      )).toBe(true);
    },
  );
});

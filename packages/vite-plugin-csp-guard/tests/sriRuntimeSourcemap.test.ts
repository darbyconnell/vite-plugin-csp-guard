import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { build, type Rolldown } from "vite";
import { describe, expect, test } from "vitest";
import vitePluginCSP from "../src";

type OutputAsset = Rolldown.OutputAsset;
type OutputChunk = Rolldown.OutputChunk;

const marker = "distinctive-original-statement";

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
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
    );
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
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const output = outputs.flatMap((entry) =>
      "output" in entry ? entry.output : [],
    );
    const chunk = output.find(
      (item): item is OutputChunk => item.type === "chunk" && item.isEntry,
    );
    const htmlAsset = output.find(
      (item): item is OutputAsset =>
        item.type === "asset" && item.fileName.endsWith(".html"),
    );

    if (!chunk || !htmlAsset) throw new Error("Fixture entry outputs missing");

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

    const html =
      typeof htmlAsset.source === "string"
        ? htmlAsset.source
        : Buffer.from(htmlAsset.source).toString("utf8");
    return { chunk, html, map, source };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("SRI runtime source maps", () => {
  test.each([true, "hidden", "inline"] as const)(
    "preserves entry mappings and integrity with sourcemap=%s",
    async (sourcemap) => {
      const { chunk, html, map, source } = await buildFixture(sourcemap);
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

      const integrity = html.match(
        /<script\b[^>]*\bsrc="([^"]+)"[^>]*\bintegrity="(sha256-[^"]+)"/,
      );
      expect(integrity).not.toBeNull();
      const expectedIntegrity = `sha256-${createHash("sha256")
        .update(Buffer.from(chunk.code))
        .digest("base64")}`;
      expect(integrity?.[2]).toBe(expectedIntegrity);
    },
  );
});

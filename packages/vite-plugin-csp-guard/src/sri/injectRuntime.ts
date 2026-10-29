import type { OutputAsset, OutputBundle, OutputChunk } from "rollup";

type MutableSourceMap = {
  mappings?: unknown;
  sections?: unknown;
};

function shiftSourceMap(map: unknown, lines: number): boolean {
  if (!map || typeof map !== "object") return false;

  const sourceMap = map as MutableSourceMap;
  if ("sections" in sourceMap || typeof sourceMap.mappings !== "string")
    return false;

  sourceMap.mappings = `${";".repeat(lines)}${sourceMap.mappings}`;
  return true;
}

function shiftMapAsset(asset: OutputAsset, lines: number): void {
  if (!asset.source) return;

  try {
    const source =
      typeof asset.source === "string"
        ? asset.source
        : Buffer.from(asset.source).toString("utf8");
    const map = JSON.parse(source) as unknown;
    if (shiftSourceMap(map, lines)) asset.source = JSON.stringify(map);
  } catch {
    // Leave unrecognized source map assets untouched.
  }
}

function shiftInlineSourceMap(code: string, lines: number): string {
  const inlineMapComment =
    /(\/\/[#@]\s*sourceMappingURL\s*=\s*|\/\*[#@]\s*sourceMappingURL\s*=\s*)(data:application\/json[^,\s]*;base64,)([A-Za-z0-9+/=_-]+)/;

  return code.replace(
    inlineMapComment,
    (comment, start, dataUrl, encodedMap) => {
      try {
        const map = JSON.parse(
          Buffer.from(encodedMap, "base64").toString("utf8"),
        ) as unknown;
        if (!shiftSourceMap(map, lines)) return comment;

        return `${start}${dataUrl}${Buffer.from(JSON.stringify(map)).toString("base64")}`;
      } catch {
        // Leave malformed or unsupported inline maps untouched.
        return comment;
      }
    },
  );
}

export function injectRuntimeAndShiftSourceMaps(
  chunk: OutputChunk,
  bundle: OutputBundle,
  prefix: string,
): void {
  const lines = (prefix.match(/\n/g) ?? []).length;
  chunk.code = prefix + chunk.code;
  if (!lines) return;

  shiftSourceMap(chunk.map, lines);

  const chunkWithMapName = chunk as OutputChunk & {
    sourcemapFileName?: string;
  };
  const mapFileName =
    chunkWithMapName.sourcemapFileName ?? `${chunk.fileName}.map`;
  const mapAsset = bundle[mapFileName];
  if (mapAsset?.type === "asset") shiftMapAsset(mapAsset, lines);

  chunk.code = shiftInlineSourceMap(chunk.code, lines);
}

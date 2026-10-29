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
  const trailingInlineMapComment =
    /(\/\/[#@]\s*sourceMappingURL\s*=\s*|\/\*[#@]\s*sourceMappingURL\s*=\s*)(data:application\/json[^,\s]*;base64,)([A-Za-z0-9+/=_-]+)(?:\s*\*\/)?\s*$/;
  const match = code.match(trailingInlineMapComment);
  if (!match || match.index === undefined) return code;

  const start = match[1]!;
  const dataUrl = match[2]!;
  const encodedMap = match[3]!;
  try {
    const map = JSON.parse(
      Buffer.from(encodedMap, "base64").toString("utf8"),
    ) as unknown;
    if (!shiftSourceMap(map, lines)) return code;

    const suffix = match[0].slice(
      start.length + dataUrl.length + encodedMap.length,
    );
    const shiftedMap = Buffer.from(JSON.stringify(map)).toString("base64");
    return `${code.slice(0, match.index)}${start}${dataUrl}${shiftedMap}${suffix}`;
  } catch {
    // Leave malformed or unsupported inline maps untouched.
    return code;
  }
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

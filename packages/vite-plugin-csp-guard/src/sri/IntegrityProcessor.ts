import type { OutputAsset, OutputBundle, OutputChunk } from "rollup";
import * as path from "path";
import { generateHash } from "../policy/core";
import type { HashAlgorithms } from "../types";

const PROCESSABLE_EXTENSIONS = /\.(css|js|mjs)($|\?)/i;

export function buildIntegrityMappings(
  bundle: OutputBundle,
  algorithm: HashAlgorithms,
  debug: boolean
): Record<string, string> {
  const integrityMap: Record<string, string> = {};

  for (const [fileName, item] of Object.entries(bundle)) {
    if (item.type === "asset" && !PROCESSABLE_EXTENSIONS.test(fileName))
      continue;

    let source: string | Uint8Array;
    if (item.type === "asset") {
      const asset = item as OutputAsset;
      if (!asset.source) continue;
      source = asset.source;
    } else if (item.type === "chunk") {
      const chunk = item as OutputChunk;
      if (!chunk.code) continue;
      source = chunk.code;
    } else {
      continue;
    }

    try {
      const hash = generateHash(source, algorithm);
      const integrity = `${algorithm}-${hash}`;
      const pathname = path.posix.join("/", fileName);
      integrityMap[pathname] = integrity;
      if (debug) {
        console.log(`[SRI] Hashed ${fileName}: ${integrity.substring(0, 30)}...`);
      }
    } catch (e) {
      if (debug) console.warn(`[SRI] Failed to hash ${fileName}:`, e);
    }
  }

  return integrityMap;
}

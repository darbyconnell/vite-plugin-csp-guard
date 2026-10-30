export type EmittedSriAsset = {
  referenceId: string;
  fileName: string;
  source: string;
};

export type SriAssetReference = Pick<EmittedSriAsset, "referenceId" | "fileName">;

export type EmitSriAsset = (asset: {
  type: "asset";
  name: string;
  source: string;
}) => SriAssetReference;

// Vite's Rolldown callback type is not assignable to Rollup's equivalent.
function getAssetFileNamePattern(
  assetFileNames: unknown,
  name: string,
  source: string,
  fallbackFileName: string,
): string {
  if (typeof assetFileNames === "function") {
    const assetInfo = {
      type: "asset",
      name,
      names: [name],
      originalFileName: undefined,
      originalFileNames: [],
      source,
    };
    return Reflect.apply(assetFileNames, undefined, [assetInfo]) as string;
  }
  return typeof assetFileNames === "string" ? assetFileNames : fallbackFileName;
}

/**
 * Preview assetFileNames to determine a relative-base root before emission.
 * The final getFileName result is checked against that preview so a custom
 * naming function cannot silently produce a runtime with the wrong root.
 */
export function emitRuntimeAsset(options: {
  name: string;
  fallbackFileName: string;
  assetFileNames: unknown;
  sourceForFileName: (fileName: string) => string;
  emitFile: EmitSriAsset;
  emittedSources: Map<string, EmittedSriAsset>;
  emittedPaths: Map<string, string>;
}): EmittedSriAsset {
  const {
    name,
    fallbackFileName,
    assetFileNames,
    sourceForFileName,
    emitFile,
    emittedSources,
    emittedPaths,
  } = options;
  let fileNameHint = emittedPaths.get(name) ?? fallbackFileName;
  let source = "";

  for (let attempt = 0; attempt < 8; attempt++) {
    source = sourceForFileName(fileNameHint);
    const pattern = getAssetFileNamePattern(
      assetFileNames,
      name,
      source,
      fallbackFileName,
    );
    if (sourceForFileName(pattern) === source) break;
    fileNameHint = pattern;
    if (attempt === 7) {
      throw new Error(
        `Could not resolve a stable output path for SRI runtime asset: ${name}`,
      );
    }
  }

  const sourceKey = `${name}\0${source}`;
  const prior = emittedSources.get(sourceKey);
  if (prior) return prior;

  const emitted = emitFile({ type: "asset", name, source });
  if (sourceForFileName(emitted.fileName) !== source) {
    throw new Error(
      `The configured assetFileNames path for ${name} depends on its final source; ` +
        "the SRI runtime root cannot be resolved safely.",
    );
  }

  const result = { ...emitted, source };
  emittedSources.set(sourceKey, result);
  emittedPaths.set(name, emitted.fileName);
  return result;
}

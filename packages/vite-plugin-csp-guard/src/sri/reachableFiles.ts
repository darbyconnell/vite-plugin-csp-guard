import type { Rolldown } from "vite";

/**
 * Output files an entry can load: its static and dynamic chunk imports,
 * followed transitively, plus the CSS and assets Vite attached to each chunk.
 * The entry's content hash covers every reachable file, so its name changes
 * whenever this embedded map changes.
 */
export function collectReachableFiles(
  bundle: Rolldown.OutputBundle,
  entryFileName: string,
  getModuleInfo: (id: string) => Rolldown.ModuleInfo | null,
  filesByModuleId: Map<string, string[]>,
): Set<string> {
  const reachable = new Set<string>();
  const stack = [entryFileName];
  while (stack.length) {
    const fileName = stack.pop()!;
    const item = bundle[fileName];
    if (!item || item.type !== "chunk") continue;

    const dynamicFiles = Object.keys(item.modules).flatMap((id) => {
      const info = getModuleInfo(id);
      return (info?.dynamicallyImportedIds ?? []).flatMap(
        (importedId) => filesByModuleId.get(importedId) ?? [],
      );
    });
    const deps = [
      ...item.imports,
      ...item.dynamicImports,
      ...(item.viteMetadata?.importedCss ?? []),
      ...(item.viteMetadata?.importedAssets ?? []),
      ...dynamicFiles,
    ];
    for (const dep of deps) {
      const dependency = bundle[dep];
      if (dependency?.type === "chunk" && dependency.isEntry) continue;
      if (dep === entryFileName || reachable.has(dep)) continue;
      reachable.add(dep);
      stack.push(dep);
    }
  }
  return reachable;
}

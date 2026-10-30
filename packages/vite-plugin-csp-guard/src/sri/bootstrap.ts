import * as cheerio from "cheerio";
import * as path from "path";
import type { Rolldown } from "vite";
import type { HashAlgorithms } from "../types";
import { generateHash } from "../policy/core";
import { collectReachableFiles } from "./reachableFiles";
import { withBasePathname } from "./processHtml";
import { installSriRuntime } from "./runtime";

const FAKE_ORIGIN = "http://vite-plugin-csp-guard.invalid";

function isRelativeBase(base: string): boolean {
  return base === "" || base === "./";
}

function basePathname(base: string): string {
  try {
    const pathname = new URL(base, `${FAKE_ORIGIN}/`).pathname;
    const decoded = decodeURI(pathname);
    return decoded.endsWith("/") ? decoded.slice(0, -1) : decoded;
  } catch {
    return "";
  }
}

function sourcePathname(
  src: string,
  htmlFileName: string,
  base: string,
): string | undefined {
  try {
    const resolved = new URL(src, `${FAKE_ORIGIN}/${htmlFileName}`);
    const isProtocolRelativeBase = base.startsWith("//");
    const isAbsoluteBase = /^[a-z][a-z\d+.-]*:\/\//i.test(base);

    if (isAbsoluteBase || isProtocolRelativeBase) {
      const baseUrl = new URL(isProtocolRelativeBase ? `http:${base}` : base);
      const effectivePort = (url: URL) =>
        url.port || (url.protocol === "https:" ? "443" : "80");
      if (
        resolved.hostname !== baseUrl.hostname ||
        effectivePort(resolved) !== effectivePort(baseUrl) ||
        (isAbsoluteBase && resolved.origin !== baseUrl.origin)
      ) {
        return undefined;
      }
    } else if (resolved.origin !== FAKE_ORIGIN) {
      return undefined;
    }

    let pathname = decodeURI(resolved.pathname);
    const prefix = basePathname(base);
    if (prefix) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
        return undefined;
      }
      pathname = pathname.slice(prefix.length);
    }
    return path.posix.normalize(pathname.replace(/^\/+/, ""));
  } catch {
    return undefined;
  }
}

/** Resolve the output chunks referenced by a page's module script tags. */
export function getHtmlModuleRootChunks(
  html: string,
  htmlFileName: string,
  bundle: Rolldown.OutputBundle,
  base: string,
): string[] {
  const $ = cheerio.load(html);
  const roots = new Set<string>();

  $("script").each((_, element) => {
    const script = $(element);
    if ((script.attr("type") || "").trim().toLowerCase() !== "module") return;
    const src = script.attr("src");
    if (!src) return;
    const fileName = sourcePathname(src, htmlFileName, base);
    if (fileName && bundle[fileName]?.type === "chunk") roots.add(fileName);
  });

  return [...roots];
}

function bootstrapHref(
  htmlFileName: string,
  bootstrapFileName: string,
  base: string,
): string {
  if (isRelativeBase(base)) {
    const relativePath = path.posix.relative(
      path.posix.dirname(htmlFileName),
      bootstrapFileName,
    );
    return relativePath.startsWith("../") ? relativePath : `./${relativePath}`;
  }
  const normalizedBase = base.replace(/\/+$/, "");
  return normalizedBase
    ? `${normalizedBase}/${bootstrapFileName}`
    : `/${bootstrapFileName}`;
}

function addBootstrapCspHash($: cheerio.CheerioAPI, hash: string): void {
  const source = `'${hash}'`;
  $("meta").each((_, element) => {
    const meta = $(element);
    if (
      (meta.attr("http-equiv") || "").toLowerCase() !==
      "content-security-policy"
    ) {
      return;
    }
    const content = meta.attr("content");
    if (!content) return;

    const directives = content.split(";");
    for (let index = 0; index < directives.length; index++) {
      const directive = directives[index]!;
      const match = /^(\s*)(script-src-elem)(?=\s|$)([\s\S]*)$/i.exec(
        directive,
      );
      if (!match) continue;
      const [, leading, name, remainder] = match;
      const trailing = /\s*$/.exec(remainder!)?.[0] ?? "";
      const values = remainder!.trim().split(/\s+/).filter(Boolean);
      if (!values.includes(source)) values.push(source);
      directives[index] =
        `${leading}${name}${values.length ? ` ${values.join(" ")}` : ""}${trailing}`;
      break;
    }
    meta.attr("content", directives.join(";"));
  });
}

export type SriBootstrapOptions = {
  html: string;
  htmlFileName: string;
  bundle: Rolldown.OutputBundle;
  base: string;
  assetsDir: string;
  algorithm: HashAlgorithms;
  sriByPathname: Record<string, string>;
  crossorigin?: string;
  shouldAddCspHash: boolean;
  sriRuntimeOptions: string;
  assetBaseOption: string;
  getModuleInfo: (id: string) => Rolldown.ModuleInfo | null;
  filesByModuleId: Map<string, string[]>;
  emitFile: (file: { type: "asset"; fileName: string; source: string }) => void;
  emittedSources: Map<string, string>;
};

/** Emit and link a classic runtime script before the page's module graph starts. */
export function injectSriBootstrap(options: SriBootstrapOptions): string {
  const {
    html,
    htmlFileName,
    bundle,
    base,
    assetsDir,
    algorithm,
    sriByPathname,
    crossorigin,
    shouldAddCspHash,
    sriRuntimeOptions,
    assetBaseOption,
    getModuleInfo,
    filesByModuleId,
    emitFile,
    emittedSources,
  } = options;
  const roots = getHtmlModuleRootChunks(html, htmlFileName, bundle, base);
  if (!roots.length) return html;

  const entryMap: Record<string, string> = {};
  for (const root of roots) {
    for (const file of collectReachableFiles(
      bundle,
      root,
      getModuleInfo,
      filesByModuleId,
    )) {
      const integrity = sriByPathname[`/${file}`];
      if (integrity) entryMap[`/${file}`] = integrity;
    }
  }
  const map = JSON.stringify(withBasePathname(entryMap, base));
  let runtimeOptions = `${sriRuntimeOptions.slice(0, -1)}${assetBaseOption}}`;
  if (isRelativeBase(base)) {
    const normalizedAssetsDir = path.posix.normalize(assetsDir);
    const bootstrapDepth =
      normalizedAssetsDir === "."
        ? 0
        : normalizedAssetsDir.split("/").filter(Boolean).length;
    const root = `new URL(${JSON.stringify("../".repeat(bootstrapDepth) || "./")},(document.currentScript && document.currentScript.src) || document.baseURI).href`;
    runtimeOptions = `${runtimeOptions.slice(0, -1)},root:${root}}`;
  }
  const source = `(${installSriRuntime.toString()})(${map},${runtimeOptions});`;
  const contentHash = generateHash(source, algorithm);
  const shortContentHash = contentHash
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, 12);
  const bootstrapFileName = path.posix.join(
    assetsDir,
    `csp-guard-sri-${shortContentHash}.js`,
  );
  const priorSource = emittedSources.get(bootstrapFileName);
  if (priorSource && priorSource !== source) {
    throw new Error(`SRI bootstrap filename collision: ${bootstrapFileName}`);
  }
  if (!priorSource) {
    emitFile({ type: "asset", fileName: bootstrapFileName, source });
    emittedSources.set(bootstrapFileName, source);
  }

  const integrity = `${algorithm}-${contentHash}`;
  const $ = cheerio.load(html);
  const firstModule = $("script")
    .filter(
      (_, element) =>
        ($(element).attr("type") || "").trim().toLowerCase() === "module",
    )
    .first();
  if (!firstModule.length) return html;

  const bootstrap = $("<script></script>")
    .attr("defer", "")
    .attr("src", bootstrapHref(htmlFileName, bootstrapFileName, base))
    .attr("integrity", integrity)
    .attr("crossorigin", crossorigin || "anonymous");
  firstModule.before(bootstrap);
  if (shouldAddCspHash) addBootstrapCspHash($, integrity);
  return $.html();
}

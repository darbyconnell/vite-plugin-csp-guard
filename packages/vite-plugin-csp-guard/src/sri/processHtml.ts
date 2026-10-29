import * as cheerio from "cheerio";
import * as path from "path";

/**
 * Pathname part of Vite's `base`, without a trailing slash: "/app/" -> "/app",
 * "https://cdn.example.com/app/" -> "/app", "/" or "./" -> "".
 */
function basePathname(base: string): string {
  try {
    const pathname = new URL(base, "http://localhost/").pathname;
    return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  } catch {
    return "";
  }
}

/**
 * Re-keys an integrity map from "/<fileName>" to the URL pathname the browser
 * requests, which includes the pathname of Vite's `base`.
 */
export function withBasePathname(
  sriByPathname: Record<string, string>,
  base: string
): Record<string, string> {
  const prefix = basePathname(base);
  if (!prefix) return sriByPathname;
  return Object.fromEntries(
    Object.entries(sriByPathname).map(([pathname, integrity]) => [
      `${prefix}${pathname}`,
      integrity,
    ])
  );
}

function getIntegrityForUrl(
  url: string,
  sriByPathname: Record<string, string>,
  htmlFileName?: string
): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(
      url,
      htmlFileName ? `http://localhost/${htmlFileName}` : "http://localhost"
    );
    return sriByPathname[parsed.pathname];
  } catch {
    return sriByPathname[url] || sriByPathname[`/${url}`];
  }
}

function matchesPattern(pattern: string, str: string): boolean {
  if (!pattern || !str) return false;
  if (pattern === str) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(str);
}

function shouldSkip(
  el: { attribs?: Record<string, string> },
  skipResources: string[]
): boolean {
  if (!skipResources.length) return false;
  const attrs = el.attribs || {};
  const id = attrs.id;
  const src = attrs.src;
  const href = attrs.href;
  for (const p of skipResources) {
    if (
      (id && matchesPattern(p, id)) ||
      (src && matchesPattern(p, src)) ||
      (href && matchesPattern(p, href))
    ) {
      return true;
    }
  }
  return false;
}

export function processHtmlForSri(
  html: string,
  sriByPathname: Record<string, string>,
  dynamicChunkFiles: Set<string>,
  base: string,
  crossorigin?: string,
  skipResources: string[] = [],
  debug: boolean = false,
  /** Replace provisional CSP hashes with hashes of the final chunk code. */
  hashReplacements?: { old: string; new: string }[],
  htmlFileName?: string
): string {
  const $ = cheerio.load(html);
  const sriByBasePathname = withBasePathname(sriByPathname, base);

  // Swap provisional CSP hashes for final ones in a single pass. Chunks with
  // identical code share a provisional hash but can end up with different
  // final code, so one hash may expand into several; a single pass also never
  // rewrites a hash that was just inserted.
  if (hashReplacements?.length) {
    const newByOld = new Map<string, Set<string>>();
    for (const { old, new: newHash } of hashReplacements) {
      if (!newByOld.has(old)) newByOld.set(old, new Set());
      newByOld.get(old)!.add(newHash);
    }
    $('meta[http-equiv="Content-Security-Policy"]').each((_, el) => {
      const content = $(el).attr("content");
      if (!content) return;
      const updated = content.replace(/'([^']+)'/g, (token, source: string) => {
        const replacements = newByOld.get(source);
        return replacements
          ? [...replacements].map((hash) => `'${hash}'`).join(" ")
          : token;
      });
      $(el).attr("content", updated);
    });
  }

  // Add integrity to existing script[src]
  // Always overwrite when we have a match - our sriByPathname is from the final bundle
  $("script[src]").each((_, el) => {
    if (shouldSkip(el, skipResources)) return;
    const src = $(el).attr("src");
    const integrity = src
      ? getIntegrityForUrl(src, sriByBasePathname, htmlFileName)
      : undefined;
    if (integrity) {
      $(el).attr("integrity", integrity);
      if (crossorigin) $(el).attr("crossorigin", crossorigin);
    }
  });

  // Add integrity to existing link[href] (stylesheet, modulepreload, preload)
  $("link[href]").each((_, el) => {
    if (shouldSkip(el, skipResources)) return;
    const relTokens = ($(el).attr("rel") || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const as = $(el).attr("as")?.toLowerCase();
    const eligible =
      relTokens.includes("stylesheet") ||
      relTokens.includes("modulepreload") ||
      (relTokens.includes("preload") && ["script", "style", "font"].includes(as || ""));
    if (!eligible) return;
    const href = $(el).attr("href");
    const integrity = href
      ? getIntegrityForUrl(href, sriByBasePathname, htmlFileName)
      : undefined;
    // Always overwrite when we have a match
    if (integrity) {
      $(el).attr("integrity", integrity);
      if (crossorigin) $(el).attr("crossorigin", crossorigin);
    }
  });

  // Inject modulepreload links for dynamic chunks
  const existingHrefs = new Set<string>();
  $("link[rel='modulepreload'], link[rel='preload']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) existingHrefs.add(href);
  });

  const preloads: string[] = [];
  for (const chunkFile of dynamicChunkFiles) {
    let href: string;
    if (base === "./" || base === "") {
      const relativePath = path.posix.relative(
        path.posix.dirname(htmlFileName || "."),
        chunkFile
      );
      href = relativePath.startsWith("../") ? relativePath : `./${relativePath}`;
    } else {
      const normalizedBase = base.replace(/\/+$/, "");
      href = normalizedBase ? `${normalizedBase}/${chunkFile}` : `/${chunkFile}`;
    }
    if (skipResources.some((pattern) => matchesPattern(pattern, href))) continue;
    if (existingHrefs.has(href)) continue;
    const pathname = `/${chunkFile}`;
    const integrity = sriByPathname[pathname];
    if (!integrity) continue;
    let tag = `<link rel="modulepreload" href="${href}" integrity="${integrity}"`;
    if (crossorigin) tag += ` crossorigin="${crossorigin}"`;
    tag += ">";
    preloads.push(tag);
  }

  if (preloads.length > 0) {
    $("head").append("\n  " + preloads.join("\n  "));
    if (debug) {
      console.log(`[SRI] Injected ${preloads.length} modulepreload links`);
    }
  }

  return $.html();
}

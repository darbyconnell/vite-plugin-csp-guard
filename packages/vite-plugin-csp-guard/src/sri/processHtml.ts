import * as cheerio from "cheerio";
import * as path from "path";

function getIntegrityForUrl(
  url: string,
  sriByPathname: Record<string, string>,
  base: string,
  htmlFileName?: string
): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(
      url,
      htmlFileName ? `http://localhost/${htmlFileName}` : "http://localhost"
    );

    let assetOrigin: { origin: string; host: string; protocolRelative: boolean } | undefined;
    try {
      if (base.startsWith("//")) {
        const baseUrl = new URL(`http:${base}`);
        assetOrigin = {
          origin: baseUrl.origin,
          host: baseUrl.host,
          protocolRelative: true,
        };
      } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(base)) {
        const baseUrl = new URL(base);
        if (baseUrl.origin !== "null") {
          assetOrigin = {
            origin: baseUrl.origin,
            host: baseUrl.host,
            protocolRelative: false,
          };
        }
      }
    } catch {
      // Path and relative bases have no asset origin at build time.
    }

    if (assetOrigin) {
      if (assetOrigin.protocolRelative) {
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          parsed.host !== assetOrigin.host
        ) {
          return undefined;
        }
      } else if (parsed.origin !== assetOrigin.origin) {
        return undefined;
      }
    } else if (
      parsed.origin !== "http://localhost" ||
      /^[a-z][a-z\d+.-]*:/i.test(url) ||
      url.startsWith("//")
    ) {
      return undefined;
    }

    return sriByPathname[parsed.pathname];
  } catch {
    return undefined;
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
  /** Replace old hashes with new in CSP (for entry chunks after runtime injection) */
  hashReplacements?: { old: string; new: string }[],
  htmlFileName?: string
): string {
  const $ = cheerio.load(html);

  // Update CSP meta tag: replace old entry hashes with new (after runtime injection)
  if (hashReplacements?.length) {
    $('meta[http-equiv="Content-Security-Policy"]').each((_, el) => {
      const content = $(el).attr("content");
      if (!content) return;
      let updated = content;
      for (const { old, new: newHash } of hashReplacements) {
        const oldQuoted = `'${old}'`;
        const newQuoted = `'${newHash}'`;
        if (updated.includes(oldQuoted)) {
          updated = updated.replace(oldQuoted, newQuoted);
        }
      }
      $(el).attr("content", updated);
    });
  }

  // Add integrity to existing script[src]
  // Always overwrite when we have a match - our sriByPathname is from the final bundle
  $("script[src]").each((_, el) => {
    if (shouldSkip(el, skipResources)) return;
    const src = $(el).attr("src");
    const integrity = src
      ? getIntegrityForUrl(src, sriByPathname, base, htmlFileName)
      : undefined;
    if (integrity) {
      $(el).attr("integrity", integrity);
      if (crossorigin) $(el).attr("crossorigin", crossorigin);
    }
  });

  // Add integrity to existing link[href] (stylesheet, modulepreload, preload)
  $("link[href]").each((_, el) => {
    if (shouldSkip(el, skipResources)) return;
    const rel = $(el).attr("rel")?.toLowerCase();
    const as = $(el).attr("as")?.toLowerCase();
    const eligible =
      rel === "stylesheet" ||
      rel === "modulepreload" ||
      (rel === "preload" && ["script", "style", "font"].includes(as || ""));
    if (!eligible) return;
    const href = $(el).attr("href");
    const integrity = href
      ? getIntegrityForUrl(href, sriByPathname, base, htmlFileName)
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

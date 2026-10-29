/**
 * Runtime SRI injection - patches DOM to add integrity to dynamically created elements.
 * This function is stringified and injected into entry chunks. Must be self-contained.
 */
export function installSriRuntime(
  sriByPathname: Record<string, string>,
  opts?: { crossorigin?: string; skipResources?: string[] }
) {
  try {
    const map = new Map(Object.entries(sriByPathname || {}));
    const cors = opts?.crossorigin;
    const skipPatterns = opts?.skipResources || [];

    const matches = (pattern: string, str: string) => {
      if (!pattern || !str) return false;
      if (pattern === str) return true;
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(str);
    };

    const shouldSkip = (el: any) => {
      for (const p of skipPatterns) {
        const id = el.getAttribute?.("id");
        const src = el.getAttribute?.("src");
        const href = el.getAttribute?.("href");
        if (
          (id && matches(p, id)) ||
          (src && matches(p, src)) ||
          (href && matches(p, href))
        )
          return true;
      }
      return false;
    };

    const getIntegrity = (url: string | null) => {
      if (!url) return;
      try {
        const u = new URL(url, (globalThis as any).location?.href || "");
        return map.get(u.pathname);
      } catch {
        return undefined;
      }
    };

    const maybeSetIntegrity = (el: any) => {
      if (!el || shouldSkip(el)) return;
      const isLink =
        typeof HTMLLinkElement !== "undefined" && el instanceof HTMLLinkElement;
      const isScript =
        typeof HTMLScriptElement !== "undefined" && el instanceof HTMLScriptElement;
      if (!isLink && !isScript) return;

      let url: string | null = null;
      if (isLink) {
        const rel = (el.rel || "").toLowerCase();
        const as = (el.getAttribute?.("as") || "").toLowerCase();
        const ok =
          rel === "stylesheet" ||
          rel === "modulepreload" ||
          (rel === "preload" && ["script", "style", "font"].includes(as));
        if (!ok) return;
        url = el.getAttribute?.("href");
      } else {
        url = el.getAttribute?.("src");
      }
      if (!url) return;

      const integrity = getIntegrity(url);
      if (!integrity || !el.setAttribute) return;
      if (!el.hasAttribute("integrity")) el.setAttribute("integrity", integrity);
      if (cors && !el.hasAttribute("crossorigin"))
        el.setAttribute("crossorigin", cors);
    };

    // Set SRI before insertion, when the browser starts fetching the resource.
    const prepareForInsertion = (node: any) => {
      if (!node) return;
      maybeSetIntegrity(node);
      const descendants = node.querySelectorAll?.("script[src],link[href]");
      if (descendants) {
        for (let i = 0; i < descendants.length; i++)
          maybeSetIntegrity(descendants[i]);
      }
    };

    const prepareNodesForInsertion = (nodes: any[]) => {
      for (const node of nodes) prepareForInsertion(node);
    };

    const origSetAttr = (Element as any)?.prototype?.setAttribute;
    if (origSetAttr) {
      (Element as any).prototype.setAttribute = function (name: string, _v: string) {
        const r = origSetAttr.apply(this, arguments as any);
        const n = String(name || "").toLowerCase();
        if (
          (n === "src" && this.nodeName?.toLowerCase() === "script") ||
          (n === "href" && this.nodeName?.toLowerCase() === "link") ||
          n === "rel" ||
          n === "as"
        ) {
          try {
            maybeSetIntegrity(this);
          } catch {}
        }
        return r;
      };
    }

    const origAppend = (Node as any)?.prototype?.appendChild;
    if (origAppend) {
      (Node as any).prototype.appendChild = function (node: any) {
        try {
          prepareForInsertion(node);
        } catch {}
        const r = origAppend.apply(this, arguments as any);
        return r;
      };
    }

    const origInsert = (Node as any)?.prototype?.insertBefore;
    if (origInsert) {
      (Node as any).prototype.insertBefore = function (node: any, ref: any) {
        try {
          prepareForInsertion(node);
        } catch {}
        return origInsert.apply(this, arguments as any);
      };
    }

    const origReplace = (Node as any)?.prototype?.replaceChild;
    if (origReplace) {
      (Node as any).prototype.replaceChild = function (newChild: any, oldChild: any) {
        try {
          prepareForInsertion(newChild);
        } catch {}
        return origReplace.apply(this, arguments as any);
      };
    }

    const origAppendEl = (Element as any)?.prototype?.append;
    if (origAppendEl) {
      (Element as any).prototype.append = function (...nodes: any[]) {
        try {
          prepareNodesForInsertion(nodes);
        } catch {}
        return origAppendEl.apply(this, arguments as any);
      };
    }

    const origPrepend = (Element as any)?.prototype?.prepend;
    if (origPrepend) {
      (Element as any).prototype.prepend = function (...nodes: any[]) {
        try {
          prepareNodesForInsertion(nodes);
        } catch {}
        return origPrepend.apply(this, arguments as any);
      };
    }

    const origBefore = (Element as any)?.prototype?.before;
    if (origBefore) {
      (Element as any).prototype.before = function (...nodes: any[]) {
        try {
          prepareNodesForInsertion(nodes);
        } catch {}
        return origBefore.apply(this, arguments as any);
      };
    }

    const origAfter = (Element as any)?.prototype?.after;
    if (origAfter) {
      (Element as any).prototype.after = function (...nodes: any[]) {
        try {
          prepareNodesForInsertion(nodes);
        } catch {}
        return origAfter.apply(this, arguments as any);
      };
    }

    const origReplaceWith = (Element as any)?.prototype?.replaceWith;
    if (origReplaceWith) {
      (Element as any).prototype.replaceWith = function (...nodes: any[]) {
        try {
          prepareNodesForInsertion(nodes);
        } catch {}
        return origReplaceWith.apply(this, arguments as any);
      };
    }

    const origInsertAdjacentElement = (Element as any)?.prototype?.insertAdjacentElement;
    if (origInsertAdjacentElement) {
      (Element as any).prototype.insertAdjacentElement = function (
        position: string,
        element: any
      ) {
        try {
          prepareForInsertion(element);
        } catch {}
        return origInsertAdjacentElement.apply(this, arguments as any);
      };
    }
  } catch {}
}

/**
 * Runtime SRI injection - patches DOM to add integrity to dynamically created elements.
 * This function is stringified and injected into entry chunks. Must be self-contained.
 */
export function installSriRuntime(
  sriByPathname: Record<string, string>,
  opts?: { crossorigin?: string; skipResources?: string[]; root?: string }
) {
  try {
    const map = new Map<string, string>();
    for (const [key, integrity] of Object.entries(sriByPathname || {})) {
      map.set(
        opts?.root ? new URL(key.slice(1), opts.root).pathname : key,
        integrity
      );
    }
    const cors = opts?.crossorigin;
    const skipMatchers = (opts?.skipResources || [])
      .filter((pattern) => !!pattern)
      .map((pattern) => {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        return new RegExp(`^${escaped}$`);
      });

    const matchesSkipPattern = (str: string | null | undefined) => {
      if (!str) return false;
      return skipMatchers.some((pattern) => pattern.test(str));
    };

    const shouldSkip = (
      el: any,
      overrides?: { url?: string | null; urlAttribute?: "src" | "href" }
    ) => {
      const id = el.getAttribute?.("id");
      const src =
        overrides?.urlAttribute === "src" ? overrides.url : el.getAttribute?.("src");
      const href =
        overrides?.urlAttribute === "href" ? overrides.url : el.getAttribute?.("href");
      return (
        matchesSkipPattern(id) ||
        matchesSkipPattern(src) ||
        matchesSkipPattern(href)
      );
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

    const maybeSetIntegrity = (
      el: any,
      overrides?: {
        url?: string | null;
        rel?: string;
        as?: string;
        urlAttribute?: "src" | "href";
      }
    ) => {
      const isHtmlElement =
        el?.nodeType === 1 &&
        el.namespaceURI === "http://www.w3.org/1999/xhtml";
      const isLink = isHtmlElement && el.localName === "link";
      const isScript = isHtmlElement && el.localName === "script";
      if (!isLink && !isScript) return;
      if (shouldSkip(el, overrides)) return;

      let url: string | null = null;
      if (isLink) {
        const rel = (overrides?.rel !== undefined ? overrides.rel : el.rel || "").toLowerCase();
        const as =
          (overrides?.as !== undefined ? overrides.as : el.getAttribute?.("as") || "").toLowerCase();
        const ok =
          rel === "stylesheet" ||
          rel === "modulepreload" ||
          (rel === "preload" && ["script", "style", "font"].includes(as));
        if (!ok) return;
        url =
          overrides?.urlAttribute === "href"
            ? overrides.url || null
            : el.getAttribute?.("href");
      } else {
        url =
          overrides?.urlAttribute === "src"
            ? overrides.url || null
            : el.getAttribute?.("src");
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
      if (!node || (node.nodeType !== 1 && node.nodeType !== 11)) return;
      if (node.nodeType === 1) maybeSetIntegrity(node);
      if (!node.firstElementChild) return;
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
      (Element as any).prototype.setAttribute = function (name: string, value: string) {
        const n = String(name || "").toLowerCase();
        const isResourceAttribute =
          (n === "src" && this.nodeName?.toLowerCase() === "script") ||
          (n === "href" && this.nodeName?.toLowerCase() === "link") ||
          n === "rel" ||
          n === "as";
        if (!isResourceAttribute) return origSetAttr.apply(this, arguments as any);

        let isConnected = false;
        try {
          isConnected = this.isConnected;
        } catch {}
        if (isConnected) {
          try {
            const incomingValue = String(value);
            if (n === "src" || n === "href") {
              maybeSetIntegrity(this, {
                url: incomingValue,
                urlAttribute: n,
              });
            } else if (n === "rel") {
              maybeSetIntegrity(this, { rel: incomingValue });
            } else {
              maybeSetIntegrity(this, { as: incomingValue });
            }
          } catch {}
        }

        const r = origSetAttr.apply(this, arguments as any);
        try {
          maybeSetIntegrity(this);
        } catch {}
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

    const patchVariadicInsertion = (prototype: any, method: string) => {
      const original = prototype?.[method];
      if (original) {
        prototype[method] = function (...nodes: any[]) {
          try {
            prepareNodesForInsertion(nodes);
          } catch {}
          return original.apply(this, arguments as any);
        };
      }
    };

    const elementPrototype = (Element as any)?.prototype;
    patchVariadicInsertion(elementPrototype, "append");
    patchVariadicInsertion(elementPrototype, "prepend");
    patchVariadicInsertion(elementPrototype, "before");
    patchVariadicInsertion(elementPrototype, "after");
    patchVariadicInsertion(elementPrototype, "replaceWith");
    patchVariadicInsertion(elementPrototype, "replaceChildren");

    const fragmentPrototype =
      typeof DocumentFragment !== "undefined"
        ? (DocumentFragment as any).prototype
        : undefined;
    patchVariadicInsertion(fragmentPrototype, "append");
    patchVariadicInsertion(fragmentPrototype, "prepend");
    patchVariadicInsertion(fragmentPrototype, "replaceChildren");

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

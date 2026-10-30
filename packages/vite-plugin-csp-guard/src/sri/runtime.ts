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

    const registryKey = Symbol.for("vite-plugin-csp-guard.sri");
    const runtimeGlobal = globalThis as any;
    const registry =
      runtimeGlobal[registryKey] ||
      (runtimeGlobal[registryKey] = {
        lookups: [],
        owned: new WeakMap<any, string>(),
        ownedCors: new WeakMap<any, string>(),
        patched: false,
      });
    if (!registry.ownedCors) registry.ownedCors = new WeakMap<any, string>();
    registry.lookups.push((el: any, url: string | null, overrides: any) => {
      if (!url || shouldSkip(el, overrides)) return;
      const integrity = getIntegrity(url);
      return integrity ? { integrity, crossorigin: cors } : undefined;
    });
    if (registry.patched) return;
    registry.patched = true;

    const installedIntegrities = registry.owned;
    const installedCrossorigins = registry.ownedCors;
    const elementPrototype = (Element as any)?.prototype;
    const origSetAttr = elementPrototype?.setAttribute;
    const origRemoveAttr = elementPrototype?.removeAttribute;

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

      let url: string | null = null;
      let isEligible = true;
      if (isLink) {
        const relTokens = (overrides?.rel !== undefined ? overrides.rel : el.rel || "")
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const as =
          (overrides?.as !== undefined ? overrides.as : el.getAttribute?.("as") || "").toLowerCase();
        isEligible =
          relTokens.includes("stylesheet") ||
          relTokens.includes("modulepreload") ||
          (relTokens.includes("preload") && ["script", "style", "font"].includes(as));
        if (isEligible) {
          url =
            overrides?.urlAttribute === "href"
              ? overrides.url || null
              : el.getAttribute?.("href");
        }
      } else {
        url =
          overrides?.urlAttribute === "src"
            ? overrides.url || null
            : el.getAttribute?.("src");
      }

      let desired: { integrity: string; crossorigin?: string } | undefined;
      if (isEligible && url) {
        for (const lookup of registry.lookups) {
          try {
            const match = lookup(el, url, overrides);
            if (match?.integrity) {
              desired = match;
              break;
            }
          } catch {}
        }
      }
      const desiredIntegrity = desired?.integrity;
      const current = el.getAttribute?.("integrity") ?? null;
      const installed = installedIntegrities.get(el);
      const isRuntimeOwned = installed !== undefined && current === installed;

      if (isRuntimeOwned) {
        if (desiredIntegrity) {
          if (desiredIntegrity !== current)
            origSetAttr?.call(el, "integrity", desiredIntegrity);
          installedIntegrities.set(el, desiredIntegrity);
        } else {
          origRemoveAttr?.call(el, "integrity");
          installedIntegrities.delete(el);
        }
      } else {
        if (installed !== undefined) installedIntegrities.delete(el);
        if (current === null && desiredIntegrity && origSetAttr) {
          origSetAttr.call(el, "integrity", desiredIntegrity);
          installedIntegrities.set(el, desiredIntegrity);
        }
      }

      // Remove only runtime-owned crossorigin when its hash no longer applies; leave author values untouched.
      const currentCrossorigin = el.getAttribute?.("crossorigin") ?? null;
      const installedCrossorigin = installedCrossorigins.get(el);
      const isRuntimeOwnedCrossorigin =
        installedCrossorigin !== undefined && currentCrossorigin === installedCrossorigin;
      if (installedCrossorigin !== undefined && !isRuntimeOwnedCrossorigin) {
        installedCrossorigins.delete(el);
      }

      if (!desiredIntegrity && isRuntimeOwnedCrossorigin && origRemoveAttr) {
        origRemoveAttr.call(el, "crossorigin");
        installedCrossorigins.delete(el);
      }

      if (
        desired?.crossorigin &&
        !el.hasAttribute("crossorigin") &&
        origSetAttr
      ) {
        origSetAttr.call(el, "crossorigin", desired.crossorigin);
        installedCrossorigins.set(el, desired.crossorigin);
      }
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

        try {
          return origSetAttr.apply(this, arguments as any);
        } finally {
          try {
            maybeSetIntegrity(this);
          } catch {}
        }
      };
    }

    const patchPropertySetter = (
      prototype: any,
      property: string,
      getOverrides: (value: string) => {
        url?: string | null;
        rel?: string;
        as?: string;
        urlAttribute?: "src" | "href";
      }
    ) => {
      try {
        if (!prototype) return;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
        if (
          !descriptor ||
          !descriptor.configurable ||
          typeof descriptor.set !== "function"
        )
          return;

        Object.defineProperty(prototype, property, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: descriptor.get
            ? function (this: any) {
                return descriptor.get!.call(this);
              }
            : undefined,
          set: function (this: any, value: any) {
            try {
              maybeSetIntegrity(this, getOverrides(String(value)));
            } catch {}
            try {
              return descriptor.set!.call(this, value);
            } finally {
              try {
                maybeSetIntegrity(this);
              } catch {}
            }
          },
        });
      } catch {}
    };

    patchPropertySetter(
      (globalThis as any).HTMLLinkElement?.prototype,
      "href",
      (url) => ({ url, urlAttribute: "href" })
    );
    patchPropertySetter(
      (globalThis as any).HTMLLinkElement?.prototype,
      "rel",
      (rel) => ({ rel })
    );
    patchPropertySetter(
      (globalThis as any).HTMLLinkElement?.prototype,
      "as",
      (as) => ({ as })
    );
    patchPropertySetter(
      (globalThis as any).HTMLScriptElement?.prototype,
      "src",
      (url) => ({ url, urlAttribute: "src" })
    );

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

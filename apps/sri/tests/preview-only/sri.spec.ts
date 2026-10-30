import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { sriTest } from "@repo/testing";
import { installSriRuntime } from "../../../../packages/vite-plugin-csp-guard/src/sri/runtime";

const integrityFor = (content: string) =>
  `sha256-${createHash("sha256").update(content).digest("base64")}`;

// Chrome 142+ gates loopback requests behind Local Network Access; keep CORS checks enabled.
test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

// SRI tests - only run in preview (build) mode since SRI is a build-time feature
test.describe("SRI integrity", () => {
  sriTest();

  test("Modulepreload links have integrity", async ({ page }) => {
    await page.goto("/");

    const modulepreloadLinks = page.locator('link[rel="modulepreload"]');
    const count = await modulepreloadLinks.count();

    // With lazy-loaded Home and Home2, we expect at least 1 modulepreload link (one per chunk)
    expect(count).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < count; i++) {
      const link = modulepreloadLinks.nth(i);
      const integrity = await link.getAttribute("integrity");
      const href = await link.getAttribute("href");
      expect(integrity, `Modulepreload link ${href} should have integrity`).not.toBeNull();
      expect(integrity).toMatch(/^sha256-/);
    }
  });

  test("No integrity errors when loading lazy chunks", async ({ page }) => {
    const integrityErrors: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        msg.type() === "error" &&
        (text.includes("integrity") || text.includes("SRI") || text.includes("Failed to load"))
      ) {
        integrityErrors.push(text);
      }
    });

    await page.goto("/");

    // Wait for lazy components to load
    await expect(
      page.getByRole("heading", { name: "Home 2", exact: true })
    ).toBeVisible({ timeout: 5000 });

    expect(
      integrityErrors,
      `Expected no integrity-related errors, got: ${integrityErrors.join("; ")}`
    ).toHaveLength(0);
  });

  test("Property-built scripts load with integrity", async ({ page }) => {
    await page.goto("/");

    const chunkHref = await page
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .first()
      .getAttribute("href");
    expect(chunkHref).not.toBeNull();

    const chunkUrl = new URL(chunkHref!, page.url());
    chunkUrl.searchParams.set("sri-regression", "positive-script");
    const result = await page.evaluate(async (src) => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = src;
      const outcome = await new Promise<"load" | "error" | "timeout">((resolve) => {
        script.onload = () => resolve("load");
        script.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
        document.head.appendChild(script);
      });
      return {
        outcome,
        integrity: script.getAttribute("integrity"),
      };
    }, chunkUrl.href);

    expect(result.outcome).toBe("load");
    expect(result.integrity).toMatch(/^sha256-/);
  });

  test("Property-built third-party scripts are not given local integrity", async ({ page }) => {
    // Add the test origin to the script policies while preserving the rest of CSP.
    await page.route("**/", async (route) => {
      if (!route.request().isNavigationRequest()) return route.continue();
      const response = await route.fetch();
      const html = await response.text();
      const updatedHtml = html.replace(
        /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i,
        (meta) => {
          const content = meta.match(/\bcontent="([^"]*)"/i);
          if (!content) return meta;
          const directives = content[1]
            .split(";")
            .map((directive) => directive.trim())
            .filter(Boolean);
          for (const name of ["script-src", "script-src-elem"]) {
            const index = directives.findIndex((directive) =>
              new RegExp(`^${name}(?:\\s|$)`, "i").test(directive),
            );
            if (index === -1) {
              directives.push(`${name} 'self' https://third-party.example`);
            } else if (!directives[index].includes("https://third-party.example")) {
              directives[index] += " https://third-party.example";
            }
          }
          return meta.replace(
            content[0],
            `content="${directives.join("; ")};"`,
          );
        },
      );
      await route.fulfill({
        response,
        body: updatedHtml,
      });
    });
    await page.goto("/");

    const chunkHref = await page
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .first()
      .getAttribute("href");
    expect(chunkHref).not.toBeNull();

    const chunkPathname = new URL(chunkHref!, page.url()).pathname;
    const thirdPartyUrl = `https://third-party.example${chunkPathname}`;
    await page.route(thirdPartyUrl, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: "window.__sriThirdPartyScriptLoaded = true;",
      }),
    );

    const result = await page.evaluate(async (src) => {
      (window as any).__sriThirdPartyScriptLoaded = false;
      const script = document.createElement("script");
      script.src = src;
      const outcome = await new Promise<"load" | "error" | "timeout">((resolve) => {
        script.onload = () => resolve("load");
        script.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
        document.head.appendChild(script);
      });
      return {
        outcome,
        integrity: script.getAttribute("integrity"),
        crossorigin: script.getAttribute("crossorigin"),
        executed: (window as any).__sriThirdPartyScriptLoaded,
      };
    }, thirdPartyUrl);

    expect(result.integrity).toBeNull();
    expect(result.crossorigin).toBeNull();
    expect(result.outcome).toBe("load");
    expect(result.executed).toBe(true);
  });

  test("Relative URLs use the current document base after pushState", async ({ page }) => {
    await page.goto("/");

    const chunkHref = await page
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .first()
      .getAttribute("href");
    expect(chunkHref).not.toBeNull();
    const chunkName = new URL(chunkHref!, page.url()).pathname.split("/").pop();

    const result = await page.evaluate((assetName) => {
      history.pushState({}, "", "/nested/");
      const script = document.createElement("script");
      script.setAttribute("src", `assets/${assetName}`);
      return {
        baseURI: document.baseURI,
        integrity: script.getAttribute("integrity"),
      };
    }, chunkName);

    expect(result.baseURI).toBe(`${new URL(page.url()).origin}/nested/`);
    expect(result.integrity).toBeNull();
  });

  test("Relative URLs resolve against document.baseURI instead of location.href", async ({ page }) => {
    await page.goto("/");

    const chunkHref = await page
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .first()
      .getAttribute("href");
    expect(chunkHref).not.toBeNull();
    const chunkName = new URL(chunkHref!, page.url()).pathname.split("/").pop();

    const result = await page.evaluate((assetName) => {
      const base = document.createElement("base");
      base.href = "/nested/";
      document.head.prepend(base);
      const script = document.createElement("script");
      script.setAttribute("src", `assets/${assetName}`);
      return {
        baseURI: document.baseURI,
        locationHref: location.href,
        integrity: script.getAttribute("integrity"),
      };
    }, chunkName);

    expect(result.baseURI).toBe(`${new URL(page.url()).origin}/nested/`);
    expect(result.locationHref).toBe(page.url());
    expect(result.integrity).toBeNull();
  });

  test("Opaque-origin iframe runtime still adds integrity to in-map resources", async ({ page }) => {
    await page.route("**/*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": "*",
        },
      });
    });
    await page.goto("/");

    await page.evaluate(() => {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.src = "/";
      document.body.appendChild(iframe);
    });

    const frame = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(frame.getByRole("heading", { name: "SRI Test App" })).toBeVisible();
    const chunkHref = await frame
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .first()
      .getAttribute("href");
    expect(chunkHref).not.toBeNull();

    const result = await frame.locator("body").evaluate((body, src) => {
      const script = document.createElement("script");
      script.setAttribute("src", src);
      let canAccessParent = true;
      try {
        void parent.document.body;
      } catch {
        canAccessParent = false;
      }
      return {
        canAccessParent,
        integrity: script.getAttribute("integrity"),
      };
    }, chunkHref!);

    expect(result.canAccessParent).toBe(false);
    expect(result.integrity).toMatch(/^sha256-/);
  });

  test("Property-built scripts are checked before they are inserted", async ({ page }) => {
    await page.goto("/");

    const chunkHref = await page
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .first()
      .getAttribute("href");
    expect(chunkHref).not.toBeNull();

    const tamperedUrl = new URL(chunkHref!, page.url());
    tamperedUrl.searchParams.set("sri-regression", "script");
    await page.route(
      (url) => url.href === tamperedUrl.href,
      (route) =>
        route.fulfill({
          contentType: "application/javascript",
          body: "window.__sriTamperedScriptExecuted = true;",
        })
    );

    const result = await page.evaluate(async (src) => {
      (window as any).__sriTamperedScriptExecuted = false;
      const script = document.createElement("script");
      script.src = src;
      const outcome = await new Promise<"load" | "error" | "timeout">((resolve) => {
        script.onload = () => resolve("load");
        script.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
        document.head.appendChild(script);
      });
      return {
        outcome,
        integrity: script.getAttribute("integrity"),
        executed: (window as any).__sriTamperedScriptExecuted,
      };
    }, tamperedUrl.href);

    expect(result.outcome).toBe("error");
    expect(result.integrity).toMatch(/^sha256-/);
    expect(result.executed).toBe(false);
  });

  test("Connected script setAttribute is checked before its fetch", async ({ page }) => {
    await page.goto("/");

    const chunkHref = await page
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .first()
      .getAttribute("href");
    expect(chunkHref).not.toBeNull();

    const tamperedUrl = new URL(chunkHref!, page.url());
    tamperedUrl.searchParams.set("sri-regression", "connected-set-attribute");
    await page.route(
      (url) => url.href === tamperedUrl.href,
      (route) =>
        route.fulfill({
          contentType: "application/javascript",
          body: "window.__sriTamperedConnectedScriptExecuted = true;",
        })
    );

    const result = await page.evaluate(async (src) => {
      (window as any).__sriTamperedConnectedScriptExecuted = false;
      const script = document.createElement("script");
      const outcome = new Promise<"load" | "error" | "timeout">((resolve) => {
        script.onload = () => resolve("load");
        script.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
      });
      document.head.appendChild(script);
      script.setAttribute("src", src);
      const result = await outcome;
      return {
        outcome: result,
        integrity: script.getAttribute("integrity"),
        executed: (window as any).__sriTamperedConnectedScriptExecuted,
      };
    }, tamperedUrl.href);

    expect(result.outcome).toBe("error");
    expect(result.integrity).toMatch(/^sha256-/);
    expect(result.executed).toBe(false);
  });

  test("replaceChildren checks scripts before insertion", async ({ page }) => {
    await page.goto("/");

    const chunkHref = await page
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .first()
      .getAttribute("href");
    expect(chunkHref).not.toBeNull();

    const tamperedUrl = new URL(chunkHref!, page.url());
    tamperedUrl.searchParams.set("sri-regression", "replace-children");
    await page.route(
      (url) => url.href === tamperedUrl.href,
      (route) =>
        route.fulfill({
          contentType: "application/javascript",
          body: "window.__sriTamperedReplaceChildrenExecuted = true;",
        })
    );

    const result = await page.evaluate(async (src) => {
      (window as any).__sriTamperedReplaceChildrenExecuted = false;
      const container = document.createElement("div");
      document.body.appendChild(container);
      const script = document.createElement("script");
      script.src = src;
      const outcome = await new Promise<"load" | "error" | "timeout">((resolve) => {
        script.onload = () => resolve("load");
        script.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
        container.replaceChildren(script);
      });
      return {
        outcome,
        integrity: script.getAttribute("integrity"),
        executed: (window as any).__sriTamperedReplaceChildrenExecuted,
      };
    }, tamperedUrl.href);

    expect(result.outcome).toBe("error");
    expect(result.integrity).toMatch(/^sha256-/);
    expect(result.executed).toBe(false);
  });

  test("Property-built stylesheets are checked before they are inserted", async ({ page }) => {
    await page.goto("/");

    const stylesheetHref = await page
      .locator('link[rel="stylesheet"][href*="/assets/index-"][href$=".css"]')
      .first()
      .getAttribute("href");
    expect(stylesheetHref).not.toBeNull();

    const tamperedUrl = new URL(stylesheetHref!, page.url());
    tamperedUrl.searchParams.set("sri-regression", "stylesheet");
    await page.route(
      (url) => url.href === tamperedUrl.href,
      (route) =>
        route.fulfill({
          contentType: "text/css",
          body: "body { --sri-tampered: yes; }",
        })
    );

    const outcome = await page.evaluate(async (href) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = "";
      link.href = href;
      const result = await new Promise<"load" | "error" | "timeout">((resolve) => {
        link.onload = () => resolve("load");
        link.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
        document.head.appendChild(link);
      });
      return {
        outcome: result,
        integrity: link.getAttribute("integrity"),
      };
    }, tamperedUrl.href);

    expect(outcome.outcome).toBe("error");
    expect(outcome.integrity).toMatch(/^sha256-/);
  });

  test("ShadowRoot append checks stylesheets before insertion", async ({ page }) => {
    await page.goto("/");

    const stylesheetHref = await page
      .locator('link[rel="stylesheet"][href*="/assets/index-"][href$=".css"]')
      .first()
      .getAttribute("href");
    expect(stylesheetHref).not.toBeNull();

    const tamperedUrl = new URL(stylesheetHref!, page.url());
    tamperedUrl.searchParams.set("sri-regression", "shadow-root-append");
    await page.route(
      (url) => url.href === tamperedUrl.href,
      (route) =>
        route.fulfill({
          contentType: "text/css",
          body: "body { --sri-shadow-tampered: yes; }",
        })
    );

    const result = await page.evaluate(async (href) => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const shadowRoot = host.attachShadow({ mode: "open" });
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = "";
      link.href = href;
      const outcome = await new Promise<"load" | "error" | "timeout">((resolve) => {
        link.onload = () => resolve("load");
        link.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
        shadowRoot.append(link);
      });
      return {
        outcome,
        integrity: link.getAttribute("integrity"),
      };
    }, tamperedUrl.href);

    expect(result.outcome).toBe("error");
    expect(result.integrity).toMatch(/^sha256-/);
  });

  test("Connected stylesheet setAttribute updates integrity when href changes", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home 2", exact: true })).toBeVisible();

    const stylesheets = await page
      .locator('link[rel="stylesheet"][href*="/assets/"][href$=".css"]')
      .evaluateAll((links) =>
        links.map((link) => ({
          href: (link as HTMLLinkElement).href,
          integrity: link.getAttribute("integrity"),
        }))
      );
    expect(stylesheets.length).toBeGreaterThanOrEqual(2);
    const [first, second] = stylesheets;
    expect(first.integrity).toMatch(/^sha256-/);
    expect(second.integrity).toMatch(/^sha256-/);

    const result = await page.evaluate(async ({ firstHref, secondHref }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = "anonymous";
      link.href = firstHref;
      const waitForLoad = () =>
        new Promise<"load" | "error" | "timeout">((resolve) => {
          link.onload = () => resolve("load");
          link.onerror = () => resolve("error");
          window.setTimeout(() => resolve("timeout"), 5000);
        });

      const firstLoad = waitForLoad();
      document.head.appendChild(link);
      await firstLoad;

      const secondLoad = waitForLoad();
      link.setAttribute("href", secondHref);
      const outcome = await secondLoad;
      return { outcome, integrity: link.getAttribute("integrity") };
    }, { firstHref: first.href, secondHref: second.href });

    expect(result.outcome).toBe("load");
    expect(result.integrity).toBe(second.integrity);
  });

  test("Connected stylesheet href property updates integrity", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home 2", exact: true })).toBeVisible();

    const stylesheets = await page
      .locator('link[rel="stylesheet"][href*="/assets/"][href$=".css"]')
      .evaluateAll((links) =>
        links.map((link) => ({
          href: (link as HTMLLinkElement).href,
          integrity: link.getAttribute("integrity"),
        }))
      );
    expect(stylesheets.length).toBeGreaterThanOrEqual(2);
    const [first, second] = stylesheets;
    expect(first.integrity).toMatch(/^sha256-/);
    expect(second.integrity).toMatch(/^sha256-/);

    const result = await page.evaluate(async ({ firstHref, secondHref }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = "anonymous";
      link.href = firstHref;
      const waitForLoad = () =>
        new Promise<"load" | "error" | "timeout">((resolve) => {
          link.onload = () => resolve("load");
          link.onerror = () => resolve("error");
          window.setTimeout(() => resolve("timeout"), 5000);
        });

      const firstLoad = waitForLoad();
      document.head.appendChild(link);
      await firstLoad;

      const secondLoad = waitForLoad();
      link.href = secondHref;
      const outcome = await secondLoad;
      return { outcome, integrity: link.getAttribute("integrity") };
    }, { firstHref: first.href, secondHref: second.href });

    expect(result.outcome).toBe("load");
    expect(result.integrity).toBe(second.integrity);
  });

  test("Connected stylesheet setAttribute applies integrity before a tampered href fetch", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home 2", exact: true })).toBeVisible();

    const stylesheets = await page
      .locator('link[rel="stylesheet"][href*="/assets/"][href$=".css"]')
      .evaluateAll((links) =>
        links.map((link) => ({
          href: (link as HTMLLinkElement).href,
          integrity: link.getAttribute("integrity"),
        }))
      );
    expect(stylesheets.length).toBeGreaterThanOrEqual(2);
    const [first, second] = stylesheets;
    const tamperedUrl = new URL(second.href);
    tamperedUrl.searchParams.set("sri-regression", "tampered-setattribute-switch");
    await page.route(tamperedUrl.href, (route) =>
      route.fulfill({ contentType: "text/css", body: "body { --sri-tampered-switch: yes; }" })
    );

    const result = await page.evaluate(async ({ firstHref, secondHref }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = "anonymous";
      link.href = firstHref;
      const waitForLoad = () =>
        new Promise<"load" | "error" | "timeout">((resolve) => {
          link.onload = () => resolve("load");
          link.onerror = () => resolve("error");
          window.setTimeout(() => resolve("timeout"), 5000);
        });

      const firstLoad = waitForLoad();
      document.head.appendChild(link);
      await firstLoad;
      const secondLoad = waitForLoad();
      link.setAttribute("href", secondHref);
      const outcome = await secondLoad;
      return { outcome, integrity: link.getAttribute("integrity") };
    }, { firstHref: first.href, secondHref: tamperedUrl.href });

    expect(result.outcome).toBe("error");
    expect(result.integrity).toBe(second.integrity);
  });

  test("Connected stylesheet href property applies integrity before a tampered fetch", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home 2", exact: true })).toBeVisible();

    const stylesheets = await page
      .locator('link[rel="stylesheet"][href*="/assets/"][href$=".css"]')
      .evaluateAll((links) =>
        links.map((link) => ({
          href: (link as HTMLLinkElement).href,
          integrity: link.getAttribute("integrity"),
        }))
      );
    expect(stylesheets.length).toBeGreaterThanOrEqual(2);
    const [first, second] = stylesheets;
    const tamperedUrl = new URL(second.href);
    tamperedUrl.searchParams.set("sri-regression", "tampered-property-switch");
    await page.route(tamperedUrl.href, (route) =>
      route.fulfill({ contentType: "text/css", body: "body { --sri-tampered-switch: yes; }" })
    );

    const result = await page.evaluate(async ({ firstHref, secondHref }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = "anonymous";
      link.href = firstHref;
      const waitForLoad = () =>
        new Promise<"load" | "error" | "timeout">((resolve) => {
          link.onload = () => resolve("load");
          link.onerror = () => resolve("error");
          window.setTimeout(() => resolve("timeout"), 5000);
        });

      const firstLoad = waitForLoad();
      document.head.appendChild(link);
      await firstLoad;
      const secondLoad = waitForLoad();
      link.href = secondHref;
      const outcome = await secondLoad;
      return { outcome, integrity: link.getAttribute("integrity") };
    }, { firstHref: first.href, secondHref: tamperedUrl.href });

    expect(result.outcome).toBe("error");
    expect(result.integrity).toBe(second.integrity);
  });

  test("Changing a runtime-owned stylesheet to an unmapped URL clears integrity", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home 2", exact: true })).toBeVisible();

    const stylesheet = await page
      .locator('link[rel="stylesheet"][href*="/assets/"][href$=".css"]')
      .first()
      .evaluate((link) => (link as HTMLLinkElement).href);
    const unmappedUrl = new URL("/sri-regression-unmapped.css", page.url()).href;
    await page.route(unmappedUrl, (route) =>
      route.fulfill({ contentType: "text/css", body: "body { --sri-unmapped: loaded; }" })
    );

    const result = await page.evaluate(async ({ stylesheet, unmappedUrl }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = "anonymous";
      link.href = stylesheet;
      const waitForLoad = () =>
        new Promise<"load" | "error" | "timeout">((resolve) => {
          link.onload = () => resolve("load");
          link.onerror = () => resolve("error");
          window.setTimeout(() => resolve("timeout"), 5000);
        });

      const firstLoad = waitForLoad();
      document.head.appendChild(link);
      await firstLoad;

      const nextLoad = waitForLoad();
      link.href = unmappedUrl;
      const outcome = await nextLoad;
      return { outcome, integrity: link.getAttribute("integrity") };
    }, { stylesheet, unmappedUrl });

    expect(result.outcome).toBe("load");
    expect(result.integrity).toBeNull();
  });

  test("Author-supplied stylesheet integrity is preserved after href changes", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home 2", exact: true })).toBeVisible();

    const stylesheets = await page
      .locator('link[rel="stylesheet"][href*="/assets/"][href$=".css"]')
      .evaluateAll((links) =>
        links.map((link) => ({
          href: (link as HTMLLinkElement).href,
          integrity: link.getAttribute("integrity"),
        }))
      );
    expect(stylesheets.length).toBeGreaterThanOrEqual(2);
    const [first, second] = stylesheets;
    expect(first.integrity).toMatch(/^sha256-/);

    const result = await page.evaluate(({ firstHref, secondHref, integrity }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = "anonymous";
      link.setAttribute("integrity", integrity!);
      link.href = firstHref;
      document.head.appendChild(link);
      link.href = secondHref;
      return link.getAttribute("integrity");
    }, { firstHref: first.href, secondHref: second.href, integrity: first.integrity });

    expect(result).toBe(first.integrity);
  });

  test("Connected script src property applies integrity before its fetch", async ({ page }) => {
    await page.goto("/");

    const chunk = await page
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .first()
      .evaluate((link) => ({
        href: (link as HTMLLinkElement).href,
        integrity: link.getAttribute("integrity"),
      }));
    const tamperedUrl = new URL(chunk.href);
    tamperedUrl.searchParams.set("sri-regression", "tampered-connected-script-property");
    await page.route(tamperedUrl.href, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: "window.__sriTamperedConnectedPropertyScript = true;",
      })
    );

    const result = await page.evaluate(async (src) => {
      (window as any).__sriTamperedConnectedPropertyScript = false;
      const script = document.createElement("script");
      script.type = "module";
      const outcome = new Promise<"load" | "error" | "timeout">((resolve) => {
        script.onload = () => resolve("load");
        script.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
      });
      document.head.appendChild(script);
      script.src = src;
      const result = await outcome;
      return {
        outcome: result,
        integrity: script.getAttribute("integrity"),
        executed: (window as any).__sriTamperedConnectedPropertyScript,
      };
    }, tamperedUrl.href);

    expect(result.outcome).toBe("error");
    expect(result.integrity).toBe(chunk.integrity);
    expect(result.executed).toBe(false);
  });

  test("Connected rel property applies integrity before a stylesheet fetch", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home 2", exact: true })).toBeVisible();

    const stylesheet = await page
      .locator('link[rel="stylesheet"][href*="/assets/"][href$=".css"]')
      .first()
      .evaluate((link) => ({
        href: (link as HTMLLinkElement).href,
        integrity: link.getAttribute("integrity"),
      }));
    const tamperedUrl = new URL(stylesheet.href);
    tamperedUrl.searchParams.set("sri-regression", "tampered-rel-switch");
    await page.route(tamperedUrl.href, (route) =>
      route.fulfill({ contentType: "text/css", body: "body { --sri-tampered-rel: yes; }" })
    );

    const result = await page.evaluate(async (href) => {
      const link = document.createElement("link");
      link.rel = "alternate";
      link.crossOrigin = "anonymous";
      link.href = href;
      document.head.appendChild(link);
      const outcome = new Promise<"load" | "error" | "timeout">((resolve) => {
        link.onload = () => resolve("load");
        link.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
      });
      link.rel = "stylesheet";
      return { outcome: await outcome, integrity: link.getAttribute("integrity") };
    }, tamperedUrl.href);

    expect(result.outcome).toBe("error");
    expect(result.integrity).toBe(stylesheet.integrity);
  });

  test("Whitespace-separated rel tokens remain eligible for runtime SRI", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home 2", exact: true })).toBeVisible();

    const stylesheet = await page
      .locator('link[rel="stylesheet"][href*="/assets/"][href$=".css"]')
      .first()
      .evaluate((link) => ({
        href: (link as HTMLLinkElement).href,
        integrity: link.getAttribute("integrity"),
      }));

    const result = await page.evaluate(async (href) => {
      const link = document.createElement("link");
      link.rel = "alternate";
      link.href = href;
      document.head.appendChild(link);
      const outcome = new Promise<"load" | "error" | "timeout">((resolve) => {
        link.onload = () => resolve("load");
        link.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
      });
      link.rel = "alternate stylesheet";
      return { outcome: await outcome, integrity: link.getAttribute("integrity") };
    }, stylesheet.href);

    expect(result.outcome).toBe("load");
    expect(result.integrity).toBe(stylesheet.integrity);
  });

  test("Separate runtime installs share ownership and apply the matching map before fetch", async ({ page }) => {
    await page.goto("/");

    const firstCss = "body { --sri-runtime-one: correct; }";
    const secondCss = "body { --sri-runtime-two: correct; }";
    const oldPath = "/sri-runtime-one.css";
    const newPath = "/sri-runtime-two.css";
    const oldUrl = new URL(oldPath, page.url()).href;
    const newUrl = new URL(newPath, page.url()).href;
    const oldIntegrity = integrityFor(firstCss);
    const newIntegrity = integrityFor(secondCss);
    await page.route(oldUrl, (route) =>
      route.fulfill({ contentType: "text/css", body: firstCss })
    );
    await page.route(newUrl, (route) =>
      route.fulfill({ contentType: "text/css", body: "body { --sri-runtime-two: tampered; }" })
    );

    await page.evaluate(installSriRuntime, { [oldPath]: oldIntegrity });
    await page.evaluate(installSriRuntime, { [newPath]: newIntegrity });
    const result = await page.evaluate(async ({ oldUrl, newUrl }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = "anonymous";
      link.href = oldUrl;
      const waitForLoad = () =>
        new Promise<"load" | "error" | "timeout">((resolve) => {
          link.onload = () => resolve("load");
          link.onerror = () => resolve("error");
          window.setTimeout(() => resolve("timeout"), 5000);
        });

      const firstLoad = waitForLoad();
      document.head.appendChild(link);
      await firstLoad;
      const secondLoad = waitForLoad();
      link.setAttribute("href", newUrl);
      const outcome = await secondLoad;
      return { outcome, integrity: link.getAttribute("integrity") };
    }, { oldUrl, newUrl });

    expect(result.outcome).toBe("error");
    expect(result.integrity).toBe(newIntegrity);
  });

  test("Detached script property changes use the latest integrity at insertion", async ({ page }) => {
    await page.goto("/");

    const chunks = await page
      .locator('link[rel="modulepreload"][href*="/assets/"]')
      .evaluateAll((links) =>
        links.map((link) => ({
          href: (link as HTMLLinkElement).href,
          integrity: link.getAttribute("integrity"),
        }))
      );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const [first, second] = chunks;
    expect(first.integrity).toMatch(/^sha256-/);
    expect(second.integrity).toMatch(/^sha256-/);

    const result = await page.evaluate(async ({ firstHref, secondHref }) => {
      const detachedContainer = document.createElement("div");
      const script = document.createElement("script");
      script.type = "module";
      script.src = firstHref;
      detachedContainer.appendChild(script);
      script.src = secondHref;

      const outcomePromise = new Promise<"load" | "error" | "timeout">((resolve) => {
        script.onload = () => resolve("load");
        script.onerror = () => resolve("error");
        window.setTimeout(() => resolve("timeout"), 5000);
      });
      document.head.appendChild(script);
      const outcome = await outcomePromise;
      return { outcome, integrity: script.getAttribute("integrity") };
    }, { firstHref: first.href, secondHref: second.href });

    expect(result.outcome).toBe("load");
    expect(result.integrity).toBe(second.integrity);
  });
});

test.describe("Runtime-owned crossorigin", () => {
  let server: Server;
  let remoteUrl: string;

  test.beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/css" });
      response.end("body { --sri-crossorigin-regression: loaded; }");
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not get the cross-origin test server port"));
          return;
        }
        resolve(address.port);
      });
    });
    remoteUrl = `http://127.0.0.1:${port}/remote.css`;
  });

  test.afterAll(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  const allowCrossOriginStylesInCsp = async (page: Page) => {
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.resourceType() !== "document" || !request.isNavigationRequest()) {
        await route.continue();
        return;
      }

      const response = await route.fetch();
      const html = await response.text();
      let foundCsp = false;
      const rewrittenHtml = html.replace(
        /<meta\b(?=[^>]*\bhttp-equiv=["']Content-Security-Policy["'])[^>]*>/gi,
        (meta) =>
          meta.replace(
            /(\bcontent=)(["'])([\s\S]*?)\2/i,
            (_attribute, name: string, quote: string, policy: string) => {
              foundCsp = true;
              const directives = policy
                .split(";")
                .map((directive) => directive.trim())
                .filter(Boolean);
              const styleSrcElemIndex = directives.findIndex((directive) =>
                /^style-src-elem(?:\s|$)/i.test(directive)
              );
              const origin = new URL(remoteUrl).origin;

              if (styleSrcElemIndex >= 0) {
                if (!directives[styleSrcElemIndex].split(/\s+/).includes(origin)) {
                  directives[styleSrcElemIndex] += ` ${origin}`;
                }
              } else {
                const styleSrc = directives.find((directive) =>
                  /^style-src(?:\s|$)/i.test(directive)
                );
                const inheritedSources = styleSrc ? styleSrc.split(/\s+/).slice(1) : [];
                if (!inheritedSources.includes(origin)) inheritedSources.push(origin);
                directives.push(`style-src-elem ${inheritedSources.join(" ")}`);
              }

              return `${name}${quote}${directives.join("; ")}${quote}`;
            }
          )
      );
      if (!foundCsp) throw new Error("Expected the SRI preview document to contain a CSP meta tag");

      const headers = { ...response.headers() };
      delete headers["content-length"];
      delete headers["content-encoding"];
      delete headers["transfer-encoding"];
      await route.fulfill({
        status: response.status(),
        headers,
        body: rewrittenHtml,
      });
    });
  };

  const getManagedStylesheetHref = async (page: Page) => {
    const href = await page
      .locator('link[rel="stylesheet"][href*="/assets/"][href$=".css"]')
      .first()
      .getAttribute("href");
    expect(href).not.toBeNull();
    return new URL(href!, page.url()).href;
  };

  test("clears owned crossorigin on URL changes", async ({ page }) => {
    await allowCrossOriginStylesInCsp(page);
    await page.goto("/");
    const stylesheet = await getManagedStylesheetHref(page);

    for (const mutation of ["property", "setAttribute"] as const) {
      const result = await page.evaluate(async ({ stylesheet, remoteUrl, mutation }) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = stylesheet;
        const waitForLoad = () =>
          new Promise<"load" | "error" | "timeout">((resolve) => {
            link.onload = () => resolve("load");
            link.onerror = () => resolve("error");
            window.setTimeout(() => resolve("timeout"), 5000);
          });

        const firstLoad = waitForLoad();
        document.head.appendChild(link);
        const firstOutcome = await firstLoad;
        const initiallyManaged = {
          integrity: link.getAttribute("integrity"),
          crossorigin: link.getAttribute("crossorigin"),
        };

        const remoteLoad = waitForLoad();
        if (mutation === "property") link.href = remoteUrl;
        else link.setAttribute("href", remoteUrl);
        const remoteOutcome = await remoteLoad;
        return {
          firstOutcome,
          initiallyManaged,
          remoteOutcome,
          integrity: link.getAttribute("integrity"),
          crossorigin: link.getAttribute("crossorigin"),
        };
      }, { stylesheet, remoteUrl, mutation });

      expect(result.firstOutcome).toBe("load");
      expect(result.initiallyManaged.integrity).toMatch(/^sha256-/);
      expect(result.initiallyManaged.crossorigin).toBe("anonymous");
      expect(result.remoteOutcome).toBe("load");
      expect(result.integrity).toBeNull();
      expect(result.crossorigin).toBeNull();
    }
  });

  test("preserves author crossorigin on an unmapped URL", async ({ page }) => {
    await allowCrossOriginStylesInCsp(page);
    await page.goto("/");
    const stylesheet = await getManagedStylesheetHref(page);

    const result = await page.evaluate(async ({ stylesheet, remoteUrl }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.setAttribute("crossorigin", "use-credentials");
      link.href = stylesheet;
      const waitForLoad = () =>
        new Promise<"load" | "error" | "timeout">((resolve) => {
          link.onload = () => resolve("load");
          link.onerror = () => resolve("error");
          window.setTimeout(() => resolve("timeout"), 5000);
        });

      const firstLoad = waitForLoad();
      document.head.appendChild(link);
      const firstOutcome = await firstLoad;
      const remoteLoad = waitForLoad();
      link.href = remoteUrl;
      const remoteOutcome = await remoteLoad;
      return {
        firstOutcome,
        remoteOutcome,
        integrity: link.getAttribute("integrity"),
        crossorigin: link.getAttribute("crossorigin"),
      };
    }, { stylesheet, remoteUrl });

    expect(result.firstOutcome).toBe("load");
    expect(result.remoteOutcome).toBe("error");
    expect(result.integrity).toBeNull();
    expect(result.crossorigin).toBe("use-credentials");
  });

  test("reapplies SRI state when switching back in-map", async ({ page }) => {
    await allowCrossOriginStylesInCsp(page);
    await page.goto("/");
    const stylesheet = await getManagedStylesheetHref(page);

    const result = await page.evaluate(async ({ stylesheet, remoteUrl }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = stylesheet;
      const waitForLoad = () =>
        new Promise<"load" | "error" | "timeout">((resolve) => {
          link.onload = () => resolve("load");
          link.onerror = () => resolve("error");
          window.setTimeout(() => resolve("timeout"), 5000);
        });

      const firstLoad = waitForLoad();
      document.head.appendChild(link);
      const firstOutcome = await firstLoad;
      const remoteLoad = waitForLoad();
      link.href = remoteUrl;
      const remoteOutcome = await remoteLoad;
      const remoteAttributes = {
        integrity: link.getAttribute("integrity"),
        crossorigin: link.getAttribute("crossorigin"),
      };
      const returnLoad = waitForLoad();
      link.href = stylesheet;
      const returnOutcome = await returnLoad;
      return {
        firstOutcome,
        remoteOutcome,
        remoteAttributes,
        returnOutcome,
        integrity: link.getAttribute("integrity"),
        crossorigin: link.getAttribute("crossorigin"),
      };
    }, { stylesheet, remoteUrl });

    expect(result.firstOutcome).toBe("load");
    expect(result.remoteOutcome).toBe("load");
    expect(result.remoteAttributes).toEqual({ integrity: null, crossorigin: null });
    expect(result.returnOutcome).toBe("load");
    expect(result.integrity).toMatch(/^sha256-/);
    expect(result.crossorigin).toBe("anonymous");
  });
});

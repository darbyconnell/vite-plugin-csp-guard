import { test, expect } from "@playwright/test";
import { sriTest } from "@repo/testing";

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

    const entrySrc = await page
      .locator('script[type="module"][src*="/assets/"]')
      .first()
      .getAttribute("src");
    expect(entrySrc).not.toBeNull();

    const tamperedUrl = new URL(entrySrc!, page.url());
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

    const entrySrc = await page
      .locator('script[type="module"][src*="/assets/"]')
      .first()
      .getAttribute("src");
    expect(entrySrc).not.toBeNull();

    const tamperedUrl = new URL(entrySrc!, page.url());
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

    const entrySrc = await page
      .locator('script[type="module"][src*="/assets/"]')
      .first()
      .getAttribute("src");
    expect(entrySrc).not.toBeNull();

    const tamperedUrl = new URL(entrySrc!, page.url());
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
      .locator('link[rel="stylesheet"][href*="/assets/"]')
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
      .locator('link[rel="stylesheet"][href*="/assets/"]')
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
});

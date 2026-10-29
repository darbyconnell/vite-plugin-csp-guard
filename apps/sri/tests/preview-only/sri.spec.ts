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
    // This app's CSP intentionally allows scripts only from 'self'. Remove that
    // policy for this test so the browser can exercise the runtime's SRI matching.
    await page.route("**/", async (route) => {
      if (!route.request().isNavigationRequest()) return route.continue();
      const response = await route.fetch();
      const html = await response.text();
      await route.fulfill({
        response,
        body: html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, ""),
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

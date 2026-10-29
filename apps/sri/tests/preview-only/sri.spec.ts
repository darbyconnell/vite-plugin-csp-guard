import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { sriTest } from "@repo/testing";
import { installSriRuntime } from "../../../../packages/vite-plugin-csp-guard/src/sri/runtime";

const integrityFor = (content: string) =>
  `sha256-${createHash("sha256").update(content).digest("base64")}`;

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

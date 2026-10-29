import { describe, expect, test } from "vitest";
import { processHtmlForSri } from "../src/sri";

describe("processHtmlForSri dynamic modulepreload URLs", () => {
  test.each([
    [
      "full URL",
      "https://cdn.example.com/app",
      "https://cdn.example.com/app/assets/lazy.js",
    ],
    [
      "protocol-relative URL",
      "//cdn.example.com/app",
      "//cdn.example.com/app/assets/lazy.js",
    ],
    ["path", "/app", "/app/assets/lazy.js"],
    ["relative path", ".", "./assets/lazy.js"],
    ["empty base", "", "/assets/lazy.js"],
  ])(
    "joins a %s base without changing its URL form",
    (_description, base, expectedHref) => {
      const html = processHtmlForSri(
        "<html><head></head><body></body></html>",
        { "/assets/lazy.js": "sha384-test" },
        new Set(["assets/lazy.js"]),
        base
      );

      expect(html).toContain(`href="${expectedHref}"`);
    }
  );

  test("does not duplicate a Vite-emitted full-URL modulepreload", () => {
    const href = "https://cdn.example.com/app/assets/lazy.js";
    const html = processHtmlForSri(
      `<html><head><link rel="modulepreload" href="${href}"></head><body></body></html>`,
      { "/assets/lazy.js": "sha384-test" },
      new Set(["assets/lazy.js"]),
      "https://cdn.example.com/app"
    );

    expect(html.match(/<link\b[^>]*rel="modulepreload"/g)).toHaveLength(1);
  });

  test("omits an exact-match skipped chunk but preloads other lazy chunks", () => {
    const html = processHtmlForSri(
      "<html><head></head><body></body></html>",
      {
        "/assets/page.js": "sha384-page",
        "/assets/other.js": "sha384-other",
      },
      new Set(["assets/page.js", "assets/other.js"]),
      "",
      undefined,
      ["/assets/page.js"]
    );

    expect(html).not.toContain('href="/assets/page.js"');
    expect(html).toContain(
      '<link rel="modulepreload" href="/assets/other.js" integrity="sha384-other"'
    );
  });

  test("matches glob exclusions for generated chunk preloads", () => {
    const html = processHtmlForSri(
      "<html><head></head><body></body></html>",
      { "/assets/page.js": "sha384-page" },
      new Set(["assets/page.js"]),
      "",
      undefined,
      ["*page*"]
    );

    expect(html).not.toContain('href="/assets/page.js"');
  });

  test("matches skipped preloads against the emitted full-URL href", () => {
    const html = processHtmlForSri(
      "<html><head></head><body></body></html>",
      { "/assets/page.js": "sha384-page" },
      new Set(["assets/page.js"]),
      "https://cdn.example.com/app",
      undefined,
      ["https://cdn.example.com/app/assets/page.js"]
    );

    expect(html).not.toContain(
      'href="https://cdn.example.com/app/assets/page.js"'
    );
  });

  test("keeps applying skipResources to existing links", () => {
    const html = processHtmlForSri(
      `<html><head>
        <link rel="modulepreload" href="/assets/page.js">
        <link rel="modulepreload" href="/assets/other.js">
      </head><body></body></html>`,
      {
        "/assets/page.js": "sha384-page",
        "/assets/other.js": "sha384-other",
      },
      new Set(),
      "",
      undefined,
      ["/assets/page.js"]
    );

    expect(html).toContain('<link rel="modulepreload" href="/assets/page.js">');
    expect(html).toContain(
      '<link rel="modulepreload" href="/assets/other.js" integrity="sha384-other"'
    );
  });
});

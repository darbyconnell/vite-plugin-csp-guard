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
});

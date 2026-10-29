import { expect, test } from "vitest";
import { processHtmlForSri } from "../src/sri/processHtml";

test("HTML link eligibility recognizes whitespace-separated rel tokens", () => {
  const html = '<html><head><link rel=" alternate stylesheet " href="/assets/theme.css"></head></html>';
  const output = processHtmlForSri(
    html,
    { "/assets/theme.css": "sha256-theme" },
    new Set(),
    ""
  );

  expect(output).toContain('integrity="sha256-theme"');
});

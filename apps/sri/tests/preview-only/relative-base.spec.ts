import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { expect, test } from "@playwright/test";

let tempRoot: string;
let outputDir: string;
let server: Server;
let origin: string;
let cssAssetName: string;
let cssIntegrity: string;

test.beforeAll(async () => {
  const appDir = path.resolve(process.cwd(), "apps/sri");
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "sri-relative-base-"));
  outputDir = path.join(tempRoot, "shop");

  await build({
    configFile: path.join(appDir, "vite.config.ts"),
    root: appDir,
    base: "./",
    logLevel: "silent",
    build: {
      outDir: outputDir,
      emptyOutDir: true,
    },
  });

  const cssFiles = (await readdir(path.join(outputDir, "assets"))).filter(
    (file) => file.endsWith(".css"),
  );
  expect(
    cssFiles.length,
    "the built app should emit a stylesheet",
  ).toBeGreaterThan(0);
  cssAssetName = cssFiles[0];
  cssIntegrity = `sha256-${createHash("sha256")
    .update(await readFile(path.join(outputDir, "assets", cssAssetName)))
    .digest("base64")}`;

  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url || "/", "http://localhost").pathname,
      );
      let filePath = path.resolve(tempRoot, `.${pathname}`);
      if (
        filePath !== tempRoot &&
        !filePath.startsWith(`${tempRoot}${path.sep}`)
      ) {
        response.writeHead(403).end();
        return;
      }
      if ((await stat(filePath).catch(() => undefined))?.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      const body = await readFile(filePath);
      const contentType = filePath.endsWith(".html")
        ? "text/html; charset=utf-8"
        : filePath.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : filePath.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "application/octet-stream";
      response.writeHead(200, { "content-type": contentType }).end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to start static server");
  origin = `http://127.0.0.1:${address.port}`;
}, 120_000);

test.afterAll(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test("relative-base runtime adds SRI to nested-deployment resources and blocks tampering", async ({
  page,
}) => {
  await page.goto(`${origin}/shop/`);
  await expect(
    page.getByRole("heading", { name: "SRI Test App" }),
  ).toBeVisible();

  let tamperedRequest = false;
  await page.route(
    (url) =>
      url.pathname === `/shop/assets/${cssAssetName}` &&
      url.searchParams.has("sri-tamper"),
    async (route) => {
      tamperedRequest = true;
      await route.fulfill({
        status: 200,
        contentType: "text/css",
        body: "body { background-color: rgb(1, 2, 3); }",
      });
    },
  );

  const result = await page.evaluate(async (assetName) => {
    const entryScript = document.querySelector<HTMLScriptElement>(
      'script[type="module"][src]',
    );
    if (!entryScript) throw new Error("Entry script was not found");

    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    const href = new URL(`../assets/${assetName}`, entryScript.src);
    href.searchParams.set("sri-tamper", "1");
    stylesheet.href = href.href;

    const outcome = new Promise<"load" | "error" | "timeout">((resolve) => {
      stylesheet.addEventListener("load", () => resolve("load"), {
        once: true,
      });
      stylesheet.addEventListener("error", () => resolve("error"), {
        once: true,
      });
      window.setTimeout(() => resolve("timeout"), 10_000);
    });
    document.head.appendChild(stylesheet);
    return {
      integrity: stylesheet.getAttribute("integrity"),
      outcome: await outcome,
    };
  }, cssAssetName);

  expect(result.integrity).toBe(cssIntegrity);
  expect(tamperedRequest).toBe(true);
  expect(result.outcome).toBe("error");
});

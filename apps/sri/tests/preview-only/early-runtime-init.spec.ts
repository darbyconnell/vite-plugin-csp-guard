import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, type Rolldown } from "vite";
import { expect, test, type Page } from "@playwright/test";
import vitePluginCSP from "../../../../packages/vite-plugin-csp-guard/src";

let tempRoot: string;
let server: Server;
let origin: string;
let nonHtmlEntry: string;

async function createFixture(root: string, withHtml: boolean) {
  await writeFile(
    path.join(root, "main.js"),
    'import "./dep.js"; window.earlyInitMain = true;\n',
  );
  await writeFile(
    path.join(root, "dep.js"),
    `import stylesheetUrl from "./early-init.css?url";
const stylesheet = new URL(stylesheetUrl, import.meta.url);
if (location.search.includes("tamper=1")) stylesheet.searchParams.set("tamper", "1");
const link = document.createElement("link");
link.rel = "stylesheet";
link.dataset.earlyInitStylesheet = "true";
link.href = stylesheet.href;
window.earlyInitLink = link;
window.earlyInitOutcome = new Promise((resolve) => {
  link.addEventListener("load", () => resolve("load"), { once: true });
  link.addEventListener("error", () => resolve("error"), { once: true });
  window.setTimeout(() => resolve("timeout"), 10000);
});
document.head.appendChild(link);
`,
  );
  await writeFile(
    path.join(root, "early-init.css"),
    "html { --early-init-style: loaded; }\n",
  );
  if (withHtml) {
    await writeFile(
      path.join(root, "index.html"),
      '<!doctype html><html><head></head><body><script type="module" async src="./main.js"></script></body></html>',
    );
  }

  const outputDir = path.join(root, "dist");
  const result = await build({
    configFile: false,
    root,
    base: "./",
    logLevel: "silent",
    plugins: [vitePluginCSP({ algorithm: "sha256", build: { sri: true } })],
    build: {
      outDir: outputDir,
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          manualChunks(id) {
            if (id.endsWith("/dep.js")) return "early-dependency";
            return null;
          },
        },
        ...(withHtml ? {} : { input: path.join(root, "main.js") }),
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (item) => item.output,
  );
  const entry = outputs.find(
    (item): item is Rolldown.OutputChunk => item.type === "chunk" && item.isEntry,
  );
  if (!entry) throw new Error("SRI fixture entry was not emitted");
  if (!entry.imports.some((fileName) => fileName.includes("early-dependency"))) {
    throw new Error("SRI fixture entry must retain its static dependency");
  }
  return { entry };
}

test.beforeAll(async () => {
  tempRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "sri-early-init-")),
  );
  const asyncRoot = path.join(tempRoot, "async");
  const entryRoot = path.join(tempRoot, "entry");
  await Promise.all([mkdir(asyncRoot), mkdir(entryRoot)]);
  await createFixture(asyncRoot, true);
  const entryBuild = await createFixture(entryRoot, false);
  nonHtmlEntry = `/entry/${entryBuild.entry.fileName}`;
  await writeFile(
    path.join(tempRoot, "entry-page.html"),
    `<!doctype html><html><head></head><body><script type="module" src="${nonHtmlEntry}"></script></body></html>`,
  );

  server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://localhost");
      let filePath = requestUrl.pathname.startsWith("/async/")
        ? path.resolve(
            tempRoot,
            "async/dist",
            `.${requestUrl.pathname.slice("/async".length)}`,
          )
        : requestUrl.pathname.startsWith("/entry/")
          ? path.resolve(
              tempRoot,
              "entry/dist",
              `.${requestUrl.pathname.slice("/entry".length)}`,
            )
          : path.resolve(tempRoot, `.${requestUrl.pathname}`);
      if (filePath !== tempRoot && !filePath.startsWith(`${tempRoot}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      if ((await stat(filePath).catch(() => undefined))?.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      let body = await readFile(filePath);
      const isHtml = filePath.endsWith(".html");
      if (isHtml && requestUrl.searchParams.has("tamper")) {
        body = Buffer.from(
          body
            .toString("utf8")
            .replace(/<script\b[^>]*type=["']module["'][^>]*>/gi, (tag) =>
              tag.replace(/\bsrc=(["'])(.*?)\1/i, (_match, quote, src) =>
                `src=${quote}${src}${src.includes("?") ? "&" : "?"}tamper=1${quote}`,
              ),
            ),
        );
      }
      if (filePath.endsWith(".css") && requestUrl.searchParams.has("tamper")) {
        body = Buffer.from("html { --early-init-tampered: applied; }\n");
      }
      const contentType = isHtml
        ? "text/html; charset=utf-8"
        : filePath.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : filePath.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "application/octet-stream";
      const send = () =>
        response.writeHead(200, { "content-type": contentType }).end(body);
      // Delaying the classic HTML bootstrap verifies that async module roots
      // cannot start evaluating before the parser-blocking initializer.
      if (/csp-guard-sri-(?!module-)[^/]+\.js$/.test(filePath)) {
        setTimeout(send, 500);
      } else {
        send();
      }
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start SRI early-init server");
  }
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

async function expectStylesheetOutcome(
  page: Page,
  expected: "load" | "error",
) {
  const result = await page.evaluate(async () => {
    const win = window as Window & {
      earlyInitOutcome?: Promise<string>;
      earlyInitLink?: HTMLLinkElement;
    };
    if (!win.earlyInitOutcome || !win.earlyInitLink) {
      throw new Error("The static dependency did not insert its stylesheet");
    }
    return {
      outcome: await win.earlyInitOutcome,
      integrity: win.earlyInitLink.getAttribute("integrity"),
    };
  });
  expect(result.integrity).toMatch(/^sha256-/);
  expect(result.outcome).toBe(expected);
  return result;
}

test("async HTML roots initialize SRI before their static dependency evaluates", async ({
  page,
}) => {
  await page.goto(`${origin}/async/?tamper=1`);
  await expectStylesheetOutcome(page, "error");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--early-init-tampered")
          .trim(),
      ),
    )
    .toBe("");
});

test("async HTML root accepts the untampered stylesheet after early initialization", async ({
  page,
}) => {
  await page.goto(`${origin}/async/`);
  await expectStylesheetOutcome(page, "load");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--early-init-style")
          .trim(),
      ),
    )
    .toBe("loaded");
});

test("non-HTML ES entries initialize SRI before their static dependencies", async ({
  page,
}) => {
  await page.goto(`${origin}/entry-page.html?tamper=1`);
  await expectStylesheetOutcome(page, "error");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--early-init-tampered")
          .trim(),
      ),
    )
    .toBe("");
});

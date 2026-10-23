import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { MANIFEST_PATH, DARK_MANIFEST_PATH } from "./manifest.js";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.OPENBEAR_PLAYWRIGHT_MODULE || "/opt/openclaw/node_modules/playwright-core")); } catch {}
const webRoot = new URL("../../", import.meta.url);
const html = readFileSync(new URL("index.html", webRoot), "utf8");
const firstPaint = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

// Exercise Chromium's manifest parser with the real first-paint script and theme controller.
test("Chromium loads matching PWA colors on startup and theme changes without changing app identity", { skip: !chromium }, async t => {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><html><head><link rel="manifest" href="${MANIFEST_PATH}"><meta name="theme-color" content="#f8f8f8"><meta name="color-scheme" content="light"><script>${firstPaint}</script></head><body><script type="module">import {setThemeMode} from '/src/theme.js'; window.setThemeMode = setThemeMode;</script></body></html>`);
      return;
    }
    const script = ["/src/theme.js", "/src/pwa/manifest.js"].includes(path);
    const asset = [MANIFEST_PATH, DARK_MANIFEST_PATH, "/icons/openbear-192.png", "/icons/openbear-512.png"].includes(path);
    if (!script && !asset) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", script ? "text/javascript" : path.endsWith(".webmanifest") ? "application/manifest+json" : "image/png");
    response.end(readFileSync(new URL(`${script ? "" : "public/"}${path.slice(1)}`, webRoot)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ executablePath: process.env.OPENBEAR_CHROME || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: "light" });
    try {
      await context.addInitScript(() => localStorage.setItem("openbear.theme.v1", "dark"));
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(() => typeof window.setThemeMode === "function");
      const cdp = await context.newCDPSession(page);
      const verify = async (theme, path, color) => {
        await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
        const result = await cdp.send("Page.getAppManifest");
        assert.equal(result.url, origin + path);
        assert.deepEqual(result.errors, []);
        const manifest = JSON.parse(result.data);
        assert.equal(manifest.theme_color, color);
        assert.equal(manifest.background_color, color);
        for (const key of ["id", "start_url", "scope"]) assert.equal(new URL(manifest[key], result.url).href, origin + "/");
        assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), color);
      };
      await verify("dark", DARK_MANIFEST_PATH, "#161616");
      await page.evaluate(() => window.setThemeMode("light"));
      await verify("light", MANIFEST_PATH, "#f8f8f8");
      await page.emulateMedia({ colorScheme: "dark" });
      await verify("light", MANIFEST_PATH, "#f8f8f8");
      await page.evaluate(() => window.setThemeMode("auto"));
      await verify("dark", DARK_MANIFEST_PATH, "#161616");
      await page.emulateMedia({ colorScheme: "light" });
      await verify("light", MANIFEST_PATH, "#f8f8f8");
      assert.deepEqual(errors, []);
      t.diagnostic(`Chromium manifest parser verified at ${width}px`);
    } finally { await context.close(); }
  }
});

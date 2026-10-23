import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = fileURLToPath(new URL('../../workspace/browser-fixture-', import.meta.url));

// close() normally removes a fixture cache. Caches still open when the process
// exits (an uncaught failure, Playwright's SIGINT exit) are removed on 'exit'.
// A SIGKILL (e.g. a caller's timeout killing the whole process group) runs no
// handler at all, so each cache name carries its owner's PID and the next
// fixture removes caches whose owner no longer exists.
const openCaches = new Set();
process.on('exit', () => { for (const dir of openCaches) rmSync(dir, {recursive: true, force: true}); });
const ownerAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
async function removeOrphanedCaches() {
  const parent = dirname(temporaryRoot), prefix = basename(temporaryRoot);
  const names = await readdir(parent).catch(() => []);
  await Promise.all(names.map(name => {
    const owner = name.startsWith(prefix) && name.slice(prefix.length).match(/^(\d+)-/);
    if (!owner || Number(owner[1]) === process.pid || ownerAlive(Number(owner[1]))) return null;
    return rm(join(parent, name), {recursive: true, force: true}).catch(() => {});
  }));
}

// Each suite owns its HTTP listener AND optimizer cache. Different Vite configs
// must not replace each other's dependency hashes while a browser is using them.
// Like the real backend, write the serving process's login mode into the page.
// authMode may be a function so a fixture can switch modes between pages.
function authModePlugin(authMode) {
  return {name: 'fixture-auth-mode', transformIndexHtml: html => html.replace('"[[controller]]"', JSON.stringify(typeof authMode === 'function' ? authMode() : authMode))};
}
// warmupTimeoutMs bounds only the Vite transform of the entries (it runs before
// any page or assertion); suites that never had a separate warmup bound pass
// their own test budget.
export async function startBrowserTestServer(t, {name, plugins, entries, authMode = 'controller', warmupTimeoutMs = 30000}) {
  await removeOrphanedCaches();
  const cacheDir = await mkdtemp(`${temporaryRoot}${process.pid}-`);
  openCaches.add(cacheDir);
  let server;
  const close = async () => {
    try { await server?.close(); }
    finally { await rm(cacheDir, {recursive: true, force: true}); openCaches.delete(cacheDir); }
  };
  try {
    server = await createServer({
      root, configFile: false, cacheDir, plugins: [vue(), authModePlugin(authMode), ...plugins],
      // No production proxy or source-edit HMR in an isolated fixture.
      server: {host: '127.0.0.1', strictPort: true, hmr: false, watch: null},
    });
    // Vite's server.listen(0) falls back to 5173. Keep Vite's initialization
    // wrapper, but pass 0 directly to the underlying Node listener: the kernel
    // reserves a unique port, without a find-free-port/close/rebind race.
    await new Promise((resolve, reject) => {
      server.httpServer.once('error', reject);
      server.httpServer.listen(0, '127.0.0.1', () => {
        server.httpServer.off('error', reject);
        resolve();
      });
    });
    const port = server.httpServer.address().port;
    assert.ok(port > 0);
    const base = `http://127.0.0.1:${port}`;
    // Transform the actual fixture entry/lazy view graph before the UI's short
    // interaction deadlines start. This executes no application/API requests.
    let timer;
    try {
      await Promise.race([
        (async () => {
          await Promise.all(entries.map(entry => server.transformRequest(entry)));
          await server.waitForRequestsIdle();
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: Vite entry warmup exceeded ${warmupTimeoutMs / 1000}s`)), warmupTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
    t.diagnostic(`${name}: origin=${base} cache=${cacheDir}`);
    return {server, base, close};
  } catch (error) {
    await close();
    throw error;
  }
}

// Readiness is a DOM/application condition, not networkidle (the real app keeps
// sockets/presence active). Preserve page errors and the failing URL for diagnosis.
export async function waitForBrowserReady(page, locator, errors) {
  try {
    await locator.waitFor({timeout: 15000});
  } catch (cause) {
    const text = await page.locator('body').innerText({timeout: 1000}).catch(() => 'unavailable');
    throw new Error(`Fixture not ready at ${page.url()}: ${JSON.stringify(errors)}\n${text.slice(0, 2800)}`, {cause});
  }
}

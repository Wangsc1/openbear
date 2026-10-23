#!/usr/bin/env node
// 用本机 headless Chrome（CDP）对 Web 参考夹具逐用例截图（只访问 127.0.0.1 上的本地夹具，不访问线上服务）。
// 夹具：<数据目录>/web-ref/serve.mjs（挂载 web/ 的真实 ConsoleMarkdown.vue，渲染 md-cases.json）。
// 用法：node web_shots.mjs <outDir> [light|dark] [width=412]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DATA = process.env.OPENBEAR_MOBILE_DATA || path.join(os.homedir(), '.cache', 'openbear-mobile');

const outDir = process.argv[2] || path.join(DATA, 'md-compare', 'web');
const theme = process.argv[3] || 'light';
const width = Number(process.argv[4] || 412);
const scale = 2.625; // 与 ob-phone（420dpi）相同的设备像素比，便于并排对比
fs.mkdirSync(outDir, { recursive: true });

const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333', `--user-data-dir=${path.join(DATA, 'web-ref', 'chrome-profile')}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = '';
for (let i = 0; i < 50 && !wsUrl; i += 1) {
  await sleep(200);
  try {
    const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl || '';
  } catch { /* retry */ }
}
if (!wsUrl) throw new Error('chrome devtools not reachable');
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: width + 32, height: 900, deviceScaleFactor: scale, mobile: true });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
await send('Page.navigate', { url: `http://127.0.0.1:18788/?width=${width}&theme=${theme}` });
for (let i = 0; i < 100; i += 1) {
  await sleep(200);
  const r = await send('Runtime.evaluate', { expression: 'window.__ready && document.querySelectorAll("section[data-case]").length', returnByValue: true });
  if (r.result?.result?.value > 0) break;
}
await sleep(1500); // KaTeX / highlight 完成
const rects = await send('Runtime.evaluate', {
  expression: 'JSON.stringify([...document.querySelectorAll("section[data-case]")].map(s=>{const r=s.getBoundingClientRect();return {id:s.id,x:r.x,y:r.y+window.scrollY,w:r.width,h:r.height}}))',
  returnByValue: true,
});
const sections = JSON.parse(rects.result.result.value);
const manifest = [];
for (const s of sections) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: Math.max(0, s.y - 8), width: width + 32, height: s.h + 16, scale: 1 } });
  const file = path.join(outDir, `web-${theme}-${s.id}.png`);
  fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  manifest.push({ id: s.id, file, heightCss: Math.round(s.h) });
}
fs.writeFileSync(path.join(outDir, `web-${theme}-manifest.json`), JSON.stringify(manifest, null, 2));
console.log(manifest.map((m) => `${m.id} h=${m.heightCss}`).join('\n'));
ws.close();
chrome.kill();

import "./browserCompatibility.js"; // API fallbacks must run before application/vendor evaluation.
import "./monaco-worker.js"; // 配置 Monaco worker，仍早于 monaco-editor 求值。
import "./pwa/bootstrap.js"; // Capture install events before the app (including lazy Settings) starts.
import "./theme.js";
import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import * as Icons from "@element-plus/icons-vue";
import { initializePageSession, pageSession } from './sessionBoundary.js';
import "./style.css";
import "./dark-theme.css";
import "./admin-mobile.css";
import "./mobile-overlays.css";
import "./mobile-inputs.css";
import './sessionBoundary.css';

let app;
const root = document.getElementById('app');
function showBoundary(message, retry = false) {
  app?.unmount(); app = null;
  root.replaceChildren();
  const panel = document.createElement('section');
  panel.className = 'session-boundary';
  panel.setAttribute('role', 'alert');
  const text = document.createElement('p'); text.textContent = message;
  const button = document.createElement('button'); button.type = 'button'; button.textContent = retry ? '重试连接' : '前往登录页';
  button.onclick = retry ? start : () => window.location.assign('/login');
  panel.append(text, button); root.append(panel);
}
window.addEventListener('openbear:session-ended', () => showBoundary('当前页面登录已失效或账号已切换，已停止请求并清理本页。请从登录页重新进入；不会自动切换身份或重发操作。'));
async function start() {
  try {
    await initializePageSession();
    if (!pageSession.initialized) return;
    if (pageSession.blocked) { showBoundary('此页面或通知不属于当前登录，请从登录页重新进入。'); return; }
    const {default: App} = await import('./App.vue');
    if (pageSession.blocked) return;
    app = createApp(App);
    for (const [name, comp] of Object.entries(Icons)) app.component(name, comp);
    app.use(ElementPlus); app.mount('#app');
  } catch { showBoundary('无法连接服务，请检查网络后重试。', true); }
}
void start();

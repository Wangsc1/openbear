import "./browserCompatibility.js"; // API fallbacks must run before application/vendor evaluation.
import "./monaco-worker.js"; // 配置 Monaco worker，仍早于 monaco-editor 求值。
import "./pwa/bootstrap.js"; // Capture install events before the app (including lazy Settings) starts.
import "./theme.js";
import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import * as Icons from "@element-plus/icons-vue";
import App from "./App.vue";
import "./style.css";
import "./dark-theme.css";
import "./admin-mobile.css";
import "./mobile-overlays.css";
import "./mobile-inputs.css";

const app = createApp(App);
for (const [name, comp] of Object.entries(Icons)) {
  app.component(name, comp);
}
app.use(ElementPlus);
app.mount("#app");

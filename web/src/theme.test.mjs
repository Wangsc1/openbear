import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import {
  THEME_STORAGE_KEY,
  createThemeController,
  normalizeThemeMode,
  readStoredThemeMode,
  resolveTheme,
} from "./theme.js";

function harness({ systemDark = false, stored = null, throwRead = false, throwWrite = false } = {}) {
  const classes = new Set();
  const root = {
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    style: {},
    dataset: {},
  };
  const mediaListeners = new Set();
  const media = {
    matches: systemDark,
    addEventListener(type, listener) { if (type === "change") mediaListeners.add(listener); },
    removeEventListener(type, listener) { if (type === "change") mediaListeners.delete(listener); },
  };
  const values = new Map(stored === null ? [] : [[THEME_STORAGE_KEY, stored]]);
  const storage = {
    getItem(key) { if (throwRead) throw new Error("storage read blocked"); return values.get(key) ?? null; },
    setItem(key, value) { if (throwWrite) throw new Error("storage write blocked"); values.set(key, value); },
  };
  const events = [];
  class FakeCustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  const windowObject = {
    matchMedia: () => media,
    CustomEvent: FakeCustomEvent,
    dispatchEvent(event) { events.push(event); },
  };
  const metas = Object.fromEntries(['theme-color', 'color-scheme'].map(name => [name, {
    content: '', setAttribute(key, value) { this[key] = value; },
  }]));
  const documentObject = {
    documentElement: root,
    querySelector(selector) { return metas[selector.match(/name="([^"]+)"/)?.[1]]; },
  };
  const controller = createThemeController({ windowObject, documentObject, storageObject: storage });
  return {
    controller,
    root,
    metas,
    documentObject,
    windowObject,
    storage,
    values,
    events,
    setSystemDark(dark) {
      media.matches = dark;
      for (const listener of mediaListeners) listener({ matches: dark });
    },
  };
}

test("theme mode normalization and resolved matrix are deterministic", () => {
  assert.equal(normalizeThemeMode("light"), "light");
  assert.equal(normalizeThemeMode("dark"), "dark");
  assert.equal(normalizeThemeMode("auto"), "auto");
  assert.equal(normalizeThemeMode("invalid"), "auto");
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("auto", false), "light");
  assert.equal(resolveTheme("auto", true), "dark");
});

test("missing preference defaults to auto and follows system changes", () => {
  const env = harness({ systemDark: false });
  assert.deepEqual(env.controller.getState(), { mode: "auto", resolvedTheme: "light", dark: false });
  assert.equal(env.root.dataset.themeMode, "auto");
  assert.equal(env.root.classList.contains("light"), true);
  env.setSystemDark(true);
  assert.deepEqual(env.controller.getState(), { mode: "auto", resolvedTheme: "dark", dark: true });
  assert.equal(env.root.classList.contains("dark"), true);
  assert.equal(env.root.style.colorScheme, "dark");
  assert.equal(env.root.style.backgroundColor, "#161616");
  assert.equal(env.metas['theme-color'].content, "#161616");
  assert.equal(env.metas['color-scheme'].content, "dark");
});

test("manual light and dark persist, ignore system changes, and auto resolves immediately", () => {
  const env = harness({ systemDark: false });
  let changes = 0;
  env.controller.subscribe(() => { changes += 1; });
  env.controller.setMode("dark");
  assert.equal(env.values.get(THEME_STORAGE_KEY), "dark");
  assert.deepEqual(env.controller.getState(), { mode: "dark", resolvedTheme: "dark", dark: true });
  env.setSystemDark(true);
  env.setSystemDark(false);
  assert.equal(changes, 1, "fixed dark must not react to system changes");
  env.controller.setMode("light");
  env.setSystemDark(true);
  assert.deepEqual(env.controller.getState(), { mode: "light", resolvedTheme: "light", dark: false });
  assert.equal(changes, 2, "fixed light must not react to system changes");
  assert.equal(env.root.style.backgroundColor, "#f8f8f8");
  assert.equal(env.metas['theme-color'].content, "#f8f8f8");
  assert.equal(env.metas['color-scheme'].content, "light");
  env.controller.setMode("auto");
  assert.deepEqual(env.controller.getState(), { mode: "auto", resolvedTheme: "dark", dark: true });
  assert.equal(env.values.get(THEME_STORAGE_KEY), "auto");
  assert.equal(env.metas['theme-color'].content, "#161616");
  assert.equal(env.metas['color-scheme'].content, "dark");
});

test("stored manual mode restores in a new controller", () => {
  const first = harness({ systemDark: false });
  first.controller.setMode("dark");
  const second = harness({ systemDark: false, stored: first.values.get(THEME_STORAGE_KEY) });
  assert.deepEqual(second.controller.getState(), { mode: "dark", resolvedTheme: "dark", dark: true });
  assert.equal(second.root.dataset.themeMode, "dark");
});

test("invalid or blocked storage reads safely fall back to auto", () => {
  assert.equal(readStoredThemeMode({ getItem: () => "sepia" }), "auto");
  assert.equal(readStoredThemeMode({ getItem() { throw new Error("denied"); } }), "auto");
  const invalid = harness({ systemDark: true, stored: "sepia" });
  assert.deepEqual(invalid.controller.getState(), { mode: "auto", resolvedTheme: "dark", dark: true });
  const blocked = harness({ systemDark: false, throwRead: true });
  assert.deepEqual(blocked.controller.getState(), { mode: "auto", resolvedTheme: "light", dark: false });
});

test("blocked storage writes do not prevent the current page choice", () => {
  const env = harness({ systemDark: true, throwWrite: true });
  assert.doesNotThrow(() => env.controller.setMode("light"));
  assert.deepEqual(env.controller.getState(), { mode: "light", resolvedTheme: "light", dark: false });
  assert.equal(env.root.classList.contains("light"), true);
  assert.equal(env.root.classList.contains("dark"), false);
});

test('actual first-paint script matches runtime chrome for stored/system theme and blocked storage', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const snapshot = env => ({
    classes: ['light', 'dark'].filter(name => env.root.classList.contains(name)),
    style: {...env.root.style}, dataset: {...env.root.dataset},
    theme: env.metas['theme-color'].content, scheme: env.metas['color-scheme'].content,
  });
  for (const systemDark of [false, true]) {
    for (const stored of [null, 'light', 'dark', 'auto', 'invalid', 'blocked-read', 'blocked-getter']) {
      const blocked = stored?.startsWith('blocked');
      const env = harness({systemDark, stored, throwRead: blocked});
      const expected = snapshot(env);
      env.root.style = {}; env.root.dataset = {};
      for (const name of ['light', 'dark']) env.root.classList.toggle(name, false);
      for (const meta of Object.values(env.metas)) meta.content = '';
      const windowObject = {...env.windowObject};
      if (stored === 'blocked-getter') Object.defineProperty(windowObject, 'localStorage', {get() {throw new Error('denied');}});
      else windowObject.localStorage = env.storage;
      vm.runInNewContext(script, {window: windowObject, document: env.documentObject});
      assert.deepEqual(snapshot(env), expected, `${stored}/${systemDark}`);
      env.controller.destroy();
    }
  }
});

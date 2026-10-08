import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse, compileStyle} from '@vue/compiler-sfc';
import postcss from 'postcss';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('./SettingsView.vue');
const {descriptor} = parse(source);
const css = postcss.parse(descriptor.styles[0].content);
const notifications = postcss.parse(parse(read('../pwa/DeviceNotifications.vue')).descriptor.styles[0].content);
const cron = postcss.parse(read('../components/cron/cron.css'));
function declarations(sheet, selector, width = 1440) {
  const result = {};
  sheet.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    for (let p = rule.parent; p; p = p.parent) {
      if (p.type === 'atrule' && p.name === 'media') {
        const max = p.params.match(/max-width:\s*(\d+)px/);
        if (max && width > Number(max[1])) return;
      }
    }
    rule.walkDecls(decl => {result[decl.prop] = decl.value;});
  });
  return result;
}
const value = (selector, property, width) => declarations(css, selector, width)[property];

test('settings and notifications share the established flat admin action palette', () => {
  const primary = declarations(cron, '.cron-root .el-button--primary:not(.is-link)');
  for (const [sheet, selector] of [[css, '.mac-text-button.is-primary'], [css, '.mac-icon-action--primary'], [notifications, '.device-notifications__button.is-primary']]) {
    const button = declarations(sheet, selector);
    assert.equal(button.background, primary.background, selector);
    assert.equal(button.color, primary.color, selector);
  }
  for (const selector of ['.mac-text-button', '.event-multi button']) assert.equal(value(selector, 'border-radius'), '6px');
  assert.equal(value('.value-pill', 'background'), 'var(--ob-chat-hover)');
  assert.equal(value('.summary-model-setting :deep(.model-picker-trigger)', 'background'), value('.value-pill', 'background'));
});

test('one scoped settings stylesheet follows root light/dark roles without a second override palette', () => {
  assert.equal(descriptor.styles.length, 1);
  assert.equal(descriptor.styles[0].scoped, true);
  assert.doesNotMatch(descriptor.styles[0].content, /linear-gradient|html\.dark/);
  const compiled = compileStyle({source: descriptor.styles[0].content, filename: 'SettingsView.vue', id: 'data-v-settings', scoped: true});
  assert.deepEqual(compiled.errors, []);
  assert.match(compiled.code, /\.mac-text-button\.is-primary\[data-v-settings\]/);
  const tokens = postcss.parse(read('../theme-tokens.css'));
  for (const theme of [':root', 'html.dark']) {
    const roles = declarations(tokens, theme);
    for (const role of ['--ob-chat-bg', '--ob-chat-text', '--ob-chat-subtle', '--ob-chat-selected', '--ob-chat-hover']) assert.ok(roles[role], `${theme} owns ${role}`);
    assert.notEqual(roles['--ob-chat-text'], roles['--ob-chat-bg']);
  }
});

test('switch states, changed settings and keyboard focus remain distinct', () => {
  assert.equal(value('.mac-toggle', 'background'), 'var(--ob-border-strong)');
  assert.equal(value('.mac-toggle.is-on', 'background'), 'var(--ob-blue)');
  assert.equal(value('.mac-toggle__knob', 'background'), 'var(--ob-switch-thumb)');
  assert.equal(value('.mac-toggle.is-on .mac-toggle__knob', 'transform'), 'translateX(18px)');
  assert.equal(value('.mac-text-button.is-primary:disabled', 'color'), 'var(--ob-text-disabled)');
  assert.equal(value('.settings-shell button:focus-visible', 'outline'), '2px solid var(--ob-focus)');
  assert.equal(value('.settings-row.is-dirty', 'background'), 'var(--ob-warning-soft)');
  assert.equal(value('.settings-effect.is-warning', 'color'), 'var(--ob-warning)');
});

test('all seven settings sections and their teleported surfaces opt into the same palette', () => {
  const names = ['SettingsHubView', 'ChannelsView', 'TemplateView', 'RathAgentsView', 'SettingsView', 'SessionsView', 'LogsView', 'InstallAppView'];
  for (const name of names) {
    const {descriptor: view} = parse(read(`./${name}.vue`));
    assert.match(view.template.content, /^\s*<[^>]+class="[^"]*\bsettings-ui\b/, name);
    for (const dialog of view.template.content.matchAll(/<el-(?:dialog|drawer)\b[^>]*>/g)) {
      assert.match(dialog[0], /class="[^"]*\bsettings-ui\b/, `${name} portal`);
    }
  }
  const shared = postcss.parse(read('./settings-ui.css'));
  const primary = declarations(cron, '.cron-root .el-button--primary:not(.is-link)');
  for (const selector of ['.settings-ui .el-button--primary:not(.is-link)', '.settings-ui > .settings-page-header .el-button--primary:not(.is-link)']) {
    const button = declarations(shared, selector);
    assert.equal(button.background, primary.background);
    assert.equal(button.color, primary.color);
  }
  assert.equal(declarations(shared, '.settings-ui .el-button--danger:not(.is-link)').color, 'var(--ob-danger)');
  for (const width of [320, 390, 760]) {
    assert.equal(declarations(shared, '.settings-ui > .settings-page-header .el-button:not(.is-link)', width)['min-height'], '40px');
    assert.equal(declarations(shared, '.settings-ui.admin-page > .settings-page-header', width).padding, '6px 12px');
  }
});

test('desktop settings scrollbar reaches the content edge while cards retain their insets', () => {
  for (const [width, inline, block] of [[1440, 24, 20], [900, 12, 12]]) {
    assert.equal(value('.settings-layout', 'padding', width), `0 0 0 ${inline}px`);
    assert.equal(value('.settings-sidebar', 'margin', width), `${block}px 0`);
    assert.equal(value('.settings-content', 'padding', width), `${block}px ${inline}px ${block + 24}px 0`);
    assert.equal(value('.settings-content', 'overflow-y', width), 'auto');
    assert.equal(value('.settings-shell', 'overflow', width), 'hidden');
  }
  assert.equal(value('.settings-layout', 'padding', 390), '0 10px');
  assert.equal(value('.settings-content', 'padding', 390), '0 0 12px');
});

test('compact layout retains its picker, touch actions and independently scrolling content', () => {
  for (const width of [320, 390, 760]) {
    assert.equal(value('.settings-content', 'overflow-y', width), 'auto');
    assert.equal(value('.settings-layout', 'overflow', width), 'hidden');
    assert.equal(value('.settings-domain-picker', 'display', width), 'flex');
    assert.equal(value('.settings-sidebar .settings-domain-list', 'display', width), 'none');
    assert.equal(value('.mac-text-button', 'min-height', width), '40px');
    assert.equal(value('.mac-segmented button', 'min-height', width), '40px');
    assert.equal(value('.settings-row__main', 'display', width), 'block');
  }
  assert.equal(value('.settings-row__main', 'display', 1440), 'grid');
  assert.equal(value('.settings-prompt-actions', 'flex-wrap'), 'wrap');
});

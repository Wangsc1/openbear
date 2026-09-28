import postcss from 'postcss';

// Only the two color-mix forms used in our styles are converted. Unknown forms
// fail the build rather than silently leaving an invalid custom property behind.
const MIX = /color-mix\(in srgb,\s*var\((--[\w-]+)\)\s+(\d+(?:\.\d+)?)%,\s*(?:var\((--[\w-]+)\)|(transparent))\s*\)/g;
const RGB_ALIAS = {
  '--stat-bg': '--ob-bg', '--stat-surface': '--ob-surface',
  '--stat-surface-soft': '--ob-surface-soft', '--stat-raised': '--ob-surface-raised',
  '--stat-text': '--ob-text', '--stat-muted': '--ob-text-muted',
  '--stat-blue': '--ob-blue', '--stat-green': '--ob-success',
  '--stat-amber': '--ob-warning', '--stat-red': '--ob-danger',
  '--stat-violet': '--ob-violet',
  '--channel-accent': '--ob-blue', '--fp-surface': '--ob-surface-raised',
};
const RGB_ROLES = new Set([
  'bg', 'surface', 'surface-soft', 'surface-raised', 'text', 'text-strong',
  'text-subtle', 'text-muted', 'blue', 'success', 'warning', 'danger',
  'info', 'violet', 'orange',
]);

function oldColor(first, percent, second) {
  const token = RGB_ALIAS[first] || first;
  const role = token.startsWith('--ob-') ? token.slice(5) : '';
  // Alpha over the same surface reproduces an opaque accent/surface mix while
  // keeping the light and dark theme's actual RGB channels. The border variant
  // likewise keeps a discernible accent instead of collapsing to a pale line.
  if (second && (second === '--ob-surface' || second === '--stat-border' || second === '--channel-line') && RGB_ROLES.has(role)) {
    return `rgb(var(${token}-rgb) / ${Number(percent) / 100})`;
  }
  if (second) {
    if ((first === '--stage-color' || first === '--model-color') && Number(percent) < 50
      && (second === '--stat-border' || second === '--stat-surface')) return 'var(--ob-focus)';
    return `var(${Number(percent) >= 50 ? first : second})`;
  }
  if (RGB_ROLES.has(role)) return `rgb(var(${token}-rgb) / ${Number(percent) / 100})`;
  // Statistics' cyan is the fixed #0e98a7 defined in that view, not a theme role.
  if (first === '--stat-cyan') return `rgb(14 152 167 / ${Number(percent) / 100})`;
  // Model/stage/channel colors have no channel triplet. An existing theme-aware
  // subtle focus tint is preferable to an opaque accent on translucent UI.
  if (first === '--stat-border' || first.endsWith('-soft')) return `var(${first})`;
  return 'var(--ob-focus)';
}

function fallback(decl) {
  let value = decl.value;
  const color = value.includes('color-mix(');
  if (color) {
    value = value.replace(MIX, (_, first, percent, second) => oldColor(first, percent, second));
    if (value.includes('color-mix(')) throw decl.error(`Unsupported color-mix fallback: ${decl.value}`);
  }
  const viewport = value.includes('dvh');
  if (viewport) value = value.replace(/(\d+(?:\.\d+)?)dvh\b/g, '$1vh');
  if (value.includes('dvh')) throw decl.error(`Unsupported dvh fallback: ${decl.value}`);
  return {value, color, viewport};
}

export default function mobileCompat() {
  const generated = new WeakSet();
  return {
    postcssPlugin: 'openbear-mobile-css-compat',
    Rule(rule) {
      // Do not process the fallback copies created below.
      if (generated.has(rule)) return;
      // Insert at the rule's original location (including nested media queries)
      // so old-engine overrides retain normal selector specificity and cascade.
      const oldColors = [], oldViewport = [];
      rule.walkDecls(decl => {
        if (!decl.value.includes('color-mix(') && !decl.value.includes('dvh')) return;
        const {value, color, viewport} = fallback(decl);
        if (color) oldColors.push(decl.clone({value}));
        if (viewport) oldViewport.push(decl.clone({value}));
      });
      const overrides = [
        ['not (color: color-mix(in srgb, red, blue))', oldColors],
        ['not (height: 100dvh)', oldViewport],
      ];
      let previous = rule;
      for (const [params, nodes] of overrides) {
        if (!nodes.length) continue;
        const guard = postcss.atRule({name: 'supports', params});
        const oldRule = rule.clone({nodes});
        generated.add(oldRule);
        guard.append(oldRule);
        previous.after(guard);
        previous = guard;
      }
    },
  };
}

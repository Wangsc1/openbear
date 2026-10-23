// Keep Monaco's glyph measurements in sync with the mobile input CSS, rather
// than only enlarging its hidden textarea and misaligning IME/caret positions.
export const MOBILE_INPUT_QUERY = '(max-width: 760px) and (hover: none) and (pointer: coarse)';
export const IOS_INPUT_QUERY = '(any-pointer: coarse)';
export function bindMobileEditorFontSize(editor, win = globalThis.window) {
  const media = [win?.matchMedia?.(MOBILE_INPUT_QUERY)];
  if (win?.CSS?.supports?.('-webkit-touch-callout', 'none')) media.push(win?.matchMedia?.(IOS_INPUT_QUERY));
  const sync = () => editor.updateOptions({fontSize: media.some(query => query?.matches) ? 16 : 13});
  sync();
  for (const query of media) {
    if (query?.addEventListener) query.addEventListener('change', sync);
    else query?.addListener?.(sync);
  }
  return () => {
    for (const query of media) {
      if (query?.removeEventListener) query.removeEventListener('change', sync);
      else query?.removeListener?.(sync);
    }
  };
}

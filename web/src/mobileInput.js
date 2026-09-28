// Keep Monaco's glyph measurements in sync with the mobile input CSS, rather
// than only enlarging its hidden textarea and misaligning IME/caret positions.
export const MOBILE_INPUT_QUERY = '(max-width: 760px), (hover: none) and (pointer: coarse), (any-pointer: coarse)';
export function bindMobileEditorFontSize(editor, win = globalThis.window) {
  const media = win?.matchMedia?.(MOBILE_INPUT_QUERY);
  const sync = () => editor.updateOptions({fontSize: media?.matches ? 16 : 13});
  sync();
  if (media?.addEventListener) media.addEventListener('change', sync);
  else media?.addListener?.(sync);
  return () => {
    if (media?.removeEventListener) media.removeEventListener('change', sync);
    else media?.removeListener?.(sync);
  };
}

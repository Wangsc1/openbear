/** 标题逐字动画的帧（复用 Web conversationTitle.js 的字素切分，emoji/组合字符不被拆开）。 */
// @ts-ignore - JS module without types
import { titleGraphemes } from '@openbear/web/conversationTitle.js';

export function nextTitleFrames(title: string): string[] {
  const graphemes: string[] = titleGraphemes(String(title || ''));
  const frames: string[] = [];
  for (let i = 1; i <= graphemes.length; i += 1) frames.push(graphemes.slice(0, i).join(''));
  return frames;
}

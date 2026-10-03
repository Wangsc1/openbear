import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';
hljs.registerLanguage('json', json);

export function formatEventData(value) {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2) ?? '';
}
export function highlightEventData(value) {
  return hljs.highlight(formatEventData(value), {language: 'json', ignoreIllegals: true}).value;
}
export function eventMessageView(message) {
  const card = message?.eventCard || {};
  return {
    name: card.name || '外部事件',
    shortId: String(card.shortId || message?.opId?.replace(/^msg:/, '') || '').slice(0, 8),
    receivedAtMs: Number(card.receivedAtMs || Number(message?.createdAt || 0) * 1000),
    count: Number(card.count || card.events?.length || 1),
    events: Array.isArray(card.events) ? card.events : [],
    summary: String(card.events?.find(e => e.summary)?.summary || ''),
  };
}

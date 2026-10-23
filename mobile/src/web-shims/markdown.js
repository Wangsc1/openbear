// 替身：web/src/views/consoleView/markdown.js
//
// 原模块在顶层创建 markdown-it/katex/highlight.js 渲染器，并引用 sessionBoundary（window）和 CSS，
// decodeHtml 用 DOM textarea 解码实体，不能直接进 RN bundle。
// web/src 的纯逻辑模块（display.js 等）只依赖其中的 plainText / answerContent / hasMeaningfulAnswerText。
// 这里按原实现（web/src/views/consoleView/markdown.js 的 protectMarkdownCode / richHtmlToMarkdown /
// plainText / answerContent）逐行移植；唯一差异是 decodeHtml 改用纯 JS 实体表解码。
// 原模块逻辑变更时需要同步本文件（由 mobile/tests/webReuse.test.mjs 的对照用例覆盖主要分支）。

const PLAIN_TEXT_CACHE_LIMIT = 500;
const PLAIN_TEXT_CACHE_MAX_SOURCE_CHARS = 80000;
const plainTextCache = new Map();

const NAMED_ENTITIES = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
	hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·',
	times: '×', divide: '÷', laquo: '«', raquo: '»', bull: '•', deg: '°', plusmn: '±', para: '¶', sect: '§',
	larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', le: '≤', ge: '≥', ne: '≠', yen: '¥', euro: '€',
};

export function escapeHtmlText(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/** 纯 JS 版本：与浏览器 textarea.innerHTML 解码实体的行为对齐（不解析/剥离标签）。 */
export function decodeHtml(text) {
	if (!text || !/[&<]/.test(text)) return String(text || '');
	return String(text).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '\ufffd';
			try { return String.fromCodePoint(code); } catch { return match; }
		}
		const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
		return named === undefined ? match : named;
	});
}

function touchCache(cache, key, value, limit) {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > limit) cache.delete(cache.keys().next().value);
	return value;
}

function inlineCode(text) {
	const raw = decodeHtml(text).replace(/`/g, 'ˋ');
	return `\`${raw}\``;
}

let markdownCodePlaceholderSeq = 0;
const FENCED_MARKDOWN_CODE_RE = /(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g;
const INLINE_MARKDOWN_CODE_RE = /(`+)[^\n]*?\1/g;

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function protectMarkdownCode(text) {
	const slots = [];
	const prefix = `\uE000OPENBEAR_MD_CODE_${markdownCodePlaceholderSeq++}_`;
	const suffix = '_\uE000';
	const stash = (raw) => {
		const key = `${prefix}${slots.length}${suffix}`;
		slots.push(raw);
		return key;
	};
	let s = String(text || '');
	s = s.replace(FENCED_MARKDOWN_CODE_RE, stash);
	s = s.replace(INLINE_MARKDOWN_CODE_RE, stash);
	const slotRe = new RegExp(`${escapeRegExp(prefix)}(\\d+)${escapeRegExp(suffix)}`, 'g');
	return {
		text: s,
		restore(value) {
			return String(value || '').replace(slotRe, (_, index) => slots[Number(index)] ?? '');
		},
	};
}

export function richHtmlToMarkdown(text) {
	const protectedMarkdown = protectMarkdownCode(String(text || ''));
	let s = protectedMarkdown.text;
	s = s.replace(/<br\s*\/?\s*>/gi, '\n');
	s = s.replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => `\n\n\`\`\`\n${decodeHtml(code)}\n\`\`\`\n\n`);
	s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\n\`\`\`\n${decodeHtml(code)}\n\`\`\`\n\n`);
	s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => inlineCode(code));
	const protectedGeneratedCode = protectMarkdownCode(s);
	s = protectedGeneratedCode.text;
	s = s.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**');
	s = s.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*');
	s = s.replace(/<(u|ins)>([\s\S]*?)<\/\1>/gi, '$2');
	s = s.replace(/<(s|strike|del)>([\s\S]*?)<\/\1>/gi, '~~$2~~');
	s = s.replace(/<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
	s = s.replace(/<a\s+href=["']?([^"'\s>]+)[^>\n]*/gi, '$1');
	s = s.replace(/<blockquote(?:\s+expandable)?[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, body) => {
		const lines = decodeHtml(body).split(/\n+/).map((line) => `> ${line}`);
		return `\n${lines.join('\n')}\n`;
	});
	return protectedMarkdown.restore(protectedGeneratedCode.restore(decodeHtml(s)));
}

export function normalizeLegacyMathBlocks(text) {
	const protectedMarkdown = protectMarkdownCode(String(text || ''));
	const normalized = protectedMarkdown.text.replace(
		/(^|\n)[ \t]*\[[ \t]*\n([\s\S]*?)\n[ \t]*\][ \t]*(?=\n|$)/g,
		(_match, before, formula) => `${before}\\[\n${formula}\n\\]`,
	);
	return protectedMarkdown.restore(normalized);
}

export function clearMarkdownCache() {
	plainTextCache.clear();
}

export function plainText(text) {
	const source = String(text || '');
	if (!source) return '';
	if (source.length <= PLAIN_TEXT_CACHE_MAX_SOURCE_CHARS) {
		const cached = plainTextCache.get(source);
		if (cached !== undefined) return touchCache(plainTextCache, source, cached, PLAIN_TEXT_CACHE_LIMIT);
		return touchCache(plainTextCache, source, richHtmlToMarkdown(source).replace(/\s+/g, ' ').trim(), PLAIN_TEXT_CACHE_LIMIT);
	}
	return richHtmlToMarkdown(source).replace(/\s+/g, ' ').trim();
}

function isPlaceholderAnswerText(text) {
	const compact = plainText(text).replace(/\s+/g, '');
	return Boolean(compact) && /^[.…]+$/.test(compact);
}

export function hasMeaningfulAnswerText(text) {
	return Boolean(plainText(text).length) && !isPlaceholderAnswerText(text);
}

export function answerContent(text) {
	return hasMeaningfulAnswerText(text) ? String(text || '') : '';
}

// 以下导出在 App 中由原生 Markdown 渲染器替代；保留同名导出，误用时显式报错而不是静默返回 HTML。
export function renderMarkdown() {
	throw new Error('renderMarkdown 是 Web 专属（HTML 输出）；App 使用 src/chat/markdown 下的正文渲染器');
}
export const renderMarkdownRaw = renderMarkdown;
export const highlightCodeHtml = renderMarkdown;

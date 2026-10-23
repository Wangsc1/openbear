// 替身：web/src/artifacts/artifactFiles.js
//
// 原模块顶层引用 vue（shallowReactive）、sessionBoundary（window/contextFetch）与 markdown-it，不能进 RN bundle。
// App 只用到其中的纯函数：artifactFormat / formatFileSize / artifactSharedPath / extractArtifactSummary 与两个上限常量。
// artifactFormat / formatFileSize / artifactSharedPath 逐行照抄原实现；extractArtifactSummary 的 Markdown 分支
// 原实现用 markdown-it 取第一个 h1 与第一个段落，这里用行扫描得到等价结果（跳过代码围栏、去掉行内标记）。
// 读取与缓存（loadArtifactMetadata/loadArtifactText）在 App 侧由 src/artifacts/artifactStore.ts 实现。
// 原模块逻辑变更时需要同步本文件（tests/b2.test.mjs 覆盖主要分支）。

export const SUMMARY_LIMIT = 96 * 1024;
export const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const CODE_EXTENSIONS = {
	js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
	json: "json", jsonl: "json", ndjson: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", conf: "ini",
	py: "python", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", sql: "sql", css: "css", scss: "scss",
	html: "xml", htm: "xml", svg: "xml", xml: "xml", vue: "xml", svelte: "xml", go: "go", rs: "rust", java: "java",
	c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
	diff: "diff", patch: "diff", dockerfile: "dockerfile", makefile: "makefile",
};
const CODE_MIMES = {"application/json": "json", "application/x-jsonlines": "json", "application/yaml": "yaml", "application/x-yaml": "yaml", "application/xml": "xml", "application/javascript": "javascript", "application/typescript": "typescript", "application/sql": "sql"};
const SAFE_IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const SAFE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"]);

export function artifactSharedPath(metadata) {
	const path = metadata?.workspacePath;
	if (typeof path !== "string" || !path.startsWith("workspace/artifacts/")) return "";
	const parts = path.slice("workspace/artifacts/".length).split("/");
	return parts.every(part => part && part !== "." && part !== ".." && !/[\\\x00-\x1f\x7f]/.test(part)) ? path : "";
}

export function artifactFormat(metadata = {}) {
	metadata = metadata || {};
	const name = String(metadata.fileName || "").toLowerCase();
	const ext = name.includes(".") ? name.split(".").pop() : name;
	const mime = String(metadata.mimeType || "").split(";")[0].trim().toLowerCase();
	if (ext === "svg" || mime === "image/svg+xml") return {kind: "code", label: "SVG 源码", language: "xml", sourceOnly: true};
	if (["html", "htm"].includes(ext) || ["text/html", "application/xhtml+xml"].includes(mime)) return {kind: "html", label: "HTML", language: "xml"};
	const generic = !mime || mime === "application/octet-stream";
	const textMime = generic || mime.startsWith("text/") || Boolean(CODE_MIMES[mime]) || mime === "application/toml";
	if ((SAFE_IMAGES.has(ext) && (generic || SAFE_IMAGE_MIMES.has(mime))) || SAFE_IMAGE_MIMES.has(mime) && !CODE_EXTENSIONS[ext] && !["md", "markdown", "txt"].includes(ext)) return {kind: "image", label: "图片", language: ""};
	if ((["md", "markdown", "mdown"].includes(ext) && textMime) || ["text/markdown", "text/x-markdown"].includes(mime)) return {kind: "markdown", label: "Markdown", language: "markdown"};
	if (CODE_EXTENSIONS[ext] && textMime) return {kind: "code", label: ext.toUpperCase(), language: CODE_EXTENSIONS[ext]};
	if (CODE_MIMES[mime]) return {kind: "code", label: CODE_MIMES[mime].toUpperCase(), language: CODE_MIMES[mime]};
	if (mime.startsWith("text/") || generic && ["txt", "log", "csv", "tsv", "rst"].includes(ext)) return {kind: "text", label: ext ? ext.toUpperCase() : "文本", language: ""};
	return {kind: "unsupported", label: ext && ext.length < 12 ? ext.toUpperCase() : "文件", language: ""};
}

export function formatFileSize(bytes) {
	const value = Number(bytes);
	if (!Number.isFinite(value) || value < 0) return "大小未知";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function inlinePlain(line) {
	return String(line)
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(\*|_)(.+?)\1/g, "$2")
		.trim();
}

export function extractArtifactSummary(text, kind) {
	if (kind !== "markdown") return {title: "", excerpt: String(text).split(/\r?\n/).filter(line => line.trim()).slice(0, 3).join(" ").slice(0, 180)};
	let title = "", excerpt = "", fence = "";
	const lines = String(text).split(/\r?\n/);
	for (let i = 0; i < lines.length && !(title && excerpt); i++) {
		const line = lines[i];
		const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) { if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = ""; continue; }
		if (fenceMatch) { fence = fenceMatch[1]; continue; }
		const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) { if (!title && heading[1].length === 1) title = inlinePlain(heading[2]); continue; }
		if (!line.trim() || /^\s{0,3}([-*+]|\d+[.)])\s/.test(line) || /^\s{0,3}(>|\||<)/.test(line) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
		if (!excerpt) {
			const para = [line];
			while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s{0,3}(#|`{3}|~{3}|[-*+]\s|\d+[.)]\s|>)/.test(lines[i + 1])) para.push(lines[++i]);
			excerpt = inlinePlain(para.join(" "));
		}
	}
	return {title: title.slice(0, 160), excerpt: excerpt.slice(0, 180)};
}

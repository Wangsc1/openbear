import {installationEnvironment} from "../pwa/install.js";

// Mobile home-screen apps need an explicit save/share flow: iOS can navigate
// away, while Android's download manager is outside the standalone window.
// Keep native downloads in ordinary browsers and desktop apps. Sharing needs a
// second tap after preparation to retain a fresh user activation.
export function onArtifactDownload(event, identity) {
	if (!identity || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || (event.button && event.button !== 0)) return false;
	const environment = installationEnvironment(window);
	const android = /Android/i.test(window.navigator?.userAgent || "");
	if (!environment.standalone || (!environment.ios && !android)) return false;
	event.preventDefault();
	event.stopPropagation();
	window.dispatchEvent(new CustomEvent("openbear:download-artifact", {detail: {href: identity.contentUrl}}));
	return true;
}

export const SHARE_FILE_LIMIT = 20 * 1024 * 1024;

// Bound memory even when metadata/Content-Length are stale or absent. Never
// buffer an arbitrarily large attachment just to make it shareable on a phone.
export async function readShareFile(identity, metadata, {signal, fetcher = fetch, onProgress} = {}) {
	if (!Number.isSafeInteger(metadata?.sizeBytes) || metadata.sizeBytes < 0) throw new Error("附件大小未知，请使用备用下载入口。");
	if (metadata.sizeBytes > SHARE_FILE_LIMIT) return null;
	const response = await fetcher(identity.downloadUrl, {credentials: "same-origin", redirect: "error", signal});
	if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请重新登录后重试。" : `下载原文件失败（HTTP ${response.status}）。`);
	const length = response.headers.get("content-length");
	if (length !== null && Number(length) > SHARE_FILE_LIMIT) { await response.body?.cancel(); return null; }
	if (!response.body) throw new Error("设备无法读取文件，请使用备用下载入口。");
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const {done, value} = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > SHARE_FILE_LIMIT) { await reader.cancel(); return null; }
			chunks.push(value);
			onProgress?.(total, metadata.sizeBytes);
		}
	} finally { reader.releaseLock(); }
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	return new File(chunks, metadata.fileName || "artifact.bin", {type: metadata.mimeType || "application/octet-stream"});
}

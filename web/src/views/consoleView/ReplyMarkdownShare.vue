<script setup>
import {onBeforeUnmount, ref, watch} from "vue";
import {ElDialog} from "element-plus";
import {ChevronRight, Copy, Download, FileText, Share2, TextQuote, X} from "@lucide/vue";
import {copyTextToClipboard} from "../../utils/clipboard.js";
import {replyShareCapabilities} from "./replyMarkdownShare.js";

const props = defineProps({content: {type: String, required: true}});
const shown = ref(false);
const sharing = ref(false);
const message = ref("");
const textAvailable = ref(false);
const shareFile = ref(null);
let selectedText = "";
let generation = 0;

function close() {
	generation++;
	shown.value = false;
	selectedText = "";
	shareFile.value = null;
	sharing.value = false;
}
function open() {
	if (!props.content.trim()) return;
	selectedText = props.content;
	const available = replyShareCapabilities(selectedText, {
		navigator: typeof navigator === "undefined" ? null : navigator,
		secure: globalThis.isSecureContext === true,
		FileClass: typeof File === "undefined" ? null : File,
	});
	textAvailable.value = available.text;
	shareFile.value = available.file;
	message.value = available.text || available.file
		? ""
		: "当前浏览器不支持系统分享，可复制原文或下载文件。";
	shown.value = true;
}
async function send(kind) {
	if (!shown.value || sharing.value || selectedText !== props.content) return;
	if (kind === "file" && !shareFile.value || kind === "text" && !textAvailable.value) return;
	sharing.value = true;
	const current = generation;
	try {
		// No await before share: the click itself must retain transient user activation.
		const pending = navigator.share(kind === "file" ? {files: [shareFile.value]} : {text: selectedText});
		await pending;
		if (current === generation) message.value = "系统分享面板已关闭；是否发送成功请在接收应用确认。";
	} catch (error) {
		if (current === generation) message.value = error?.name === "AbortError"
			? "已取消分享，内容没有自动发送；可重新选择。"
			: "未能打开系统分享面板，请重试或使用复制/下载。";
	} finally {
		if (current === generation) sharing.value = false;
	}
}
async function copy() {
	if (!shown.value || selectedText !== props.content) return;
	const current = generation;
	try {
		await copyTextToClipboard(selectedText);
		if (current === generation) message.value = "Markdown 原文已复制，可自行粘贴。";
	} catch {
		if (current === generation) message.value = "复制失败，请手动选择回复文字，或下载 .md 文件。";
	}
}
function download() {
	if (!shown.value || selectedText !== props.content) return;
	try {
		const url = URL.createObjectURL(new Blob([selectedText], {type: "text/markdown;charset=utf-8"}));
		const link = document.createElement("a");
		link.href = url;
		link.download = "openbear-reply.md";
		link.style.display = "none";
		document.body.appendChild(link);
		try { link.click(); } finally { link.remove(); }
		// Some mobile browsers resolve the download after the click returns.
		window.setTimeout(() => URL.revokeObjectURL(url), 60000);
		message.value = "已交给浏览器下载；请在设备的下载或文件应用中确认是否保存。";
	} catch {
		message.value = "下载失败，请尝试复制 Markdown。";
	}
}
watch(() => props.content, close);
onBeforeUnmount(close);
</script>

<template>
	<span class="reply-share-control">
		<button type="button" class="reply-share-trigger" aria-label="分享回复 Markdown" aria-haspopup="dialog" :aria-expanded="shown" @click="open"><Share2 size="1em" :stroke-width="1.8" aria-hidden="true"/></button>
		<ElDialog
			v-model="shown" title="分享回复" class="reply-share-dialog" modal-class="reply-share-modal"
			width="420px" append-to-body destroy-on-close :show-close="false"
			:close-on-click-modal="true" :close-on-press-escape="true" @close="close"
		>
			<template #header="{titleId}">
				<div class="reply-share-heading">
					<span class="reply-share-emblem" aria-hidden="true"><Share2 :size="21" :stroke-width="1.7" /></span>
					<div class="reply-share-title"><h2 :id="titleId">分享回复</h2><p>保留 Markdown 原文</p></div>
					<button type="button" class="reply-share-close" aria-label="关闭分享回复" @click="close"><X :size="19" :stroke-width="1.8" aria-hidden="true" /></button>
				</div>
			</template>
			<div v-if="textAvailable || shareFile" class="reply-share-options">
				<button v-if="textAvailable" type="button" class="reply-share-option" :disabled="sharing" @click="send('text')">
					<span class="reply-share-option-icon" aria-hidden="true"><TextQuote :size="21" :stroke-width="1.7" /></span>
					<span class="reply-share-option-text"><strong>分享 Markdown 文本…</strong><small>将原文发送到其他应用</small></span>
					<ChevronRight class="reply-share-chevron" :size="17" aria-hidden="true" />
				</button>
				<button v-if="shareFile" type="button" class="reply-share-option" :disabled="sharing" @click="send('file')">
					<span class="reply-share-option-icon reply-share-option-icon--file" aria-hidden="true"><FileText :size="21" :stroke-width="1.7" /></span>
					<span class="reply-share-option-text"><strong>分享 .md 文件…</strong><small>作为 Markdown 文档发送</small></span>
					<ChevronRight class="reply-share-chevron" :size="17" aria-hidden="true" />
				</button>
			</div>
			<div class="reply-share-utilities">
				<button type="button" :disabled="sharing" @click="copy"><Copy :size="17" :stroke-width="1.7" aria-hidden="true" /><span>复制 Markdown</span></button>
				<button type="button" :disabled="sharing" @click="download"><Download :size="17" :stroke-width="1.7" aria-hidden="true" /><span>下载 .md 文件</span></button>
			</div>
			<p v-if="message" class="reply-share-status" role="status">{{ message }}</p>
			<p class="reply-share-note">仅回复正文，附件文件不会打包进 .md。</p>
		</ElDialog>
	</span>
</template>

<style>
.reply-share-control { display: none; }
.reply-share-modal.el-overlay { background: rgb(0 0 0 / .32); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
.reply-share-modal .el-overlay-dialog { display: flex; align-items: center; justify-content: center; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
.reply-share-dialog.el-dialog { box-sizing: border-box; display: flex; flex-direction: column; width: 420px; max-width: 100%; max-height: 100%; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--ob-border); border-radius: 22px; background: var(--ob-surface-raised); color: var(--ob-text); box-shadow: var(--ob-shadow-dialog); }
.reply-share-dialog > .el-dialog__header { flex: none; margin: 0; padding: 22px 18px 20px 22px; }
.reply-share-dialog > .el-dialog__body { min-height: 0; padding: 0 18px 18px; overflow-y: auto; overscroll-behavior: contain; }
.reply-share-heading { display: flex; align-items: center; gap: 12px; }
.reply-share-emblem { display: grid; place-items: center; flex: none; width: 44px; height: 44px; border-radius: 14px; color: var(--ob-blue); background: var(--ob-blue-soft); }
.reply-share-title { flex: 1; min-width: 0; }
.reply-share-title h2 { margin: 0; font-size: 17px; font-weight: 650; line-height: 1.4; letter-spacing: -.3px; color: var(--ob-text-strong); }
.reply-share-title p { margin: 3px 0 0; font-size: 12px; line-height: 1.4; color: var(--ob-text-muted); }
.reply-share-dialog button { font-family: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background-color .16s, border-color .16s; }
.reply-share-close { display: grid; place-items: center; flex: none; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--ob-text-muted); }
.reply-share-options { overflow: hidden; border: 1px solid var(--ob-border-soft); border-radius: 14px; background: var(--ob-surface); }
.reply-share-option { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 76px; padding: 14px; text-align: left; border: 0; background: transparent; color: var(--ob-text-strong); }
.reply-share-option + .reply-share-option { border-top: 1px solid var(--ob-border-soft); }
.reply-share-option-icon { display: grid; place-items: center; flex: none; width: 38px; height: 38px; border-radius: 11px; color: var(--ob-blue); background: var(--ob-blue-soft); }
.reply-share-option-icon--file { color: var(--ob-text-subtle); background: var(--ob-surface-soft); }
.reply-share-option-text { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 4px; }
.reply-share-option-text strong { font-size: 13px; font-weight: 600; line-height: 1.5; }
.reply-share-option-text small { font-size: 11px; line-height: 1.45; color: var(--ob-text-muted); }
.reply-share-chevron { flex: none; color: var(--ob-text-muted); }
.reply-share-utilities { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.reply-share-options + .reply-share-utilities { margin-top: 12px; }
.reply-share-utilities button { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 46px; padding: 10px 6px; border: 1px solid var(--ob-border); border-radius: 12px; background: var(--ob-surface-soft); color: var(--ob-text-subtle); font-size: 12px; line-height: 1.4; }
.reply-share-utilities svg { flex: none; }
.reply-share-dialog .reply-share-status { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; background: var(--ob-blue-soft); color: var(--ob-text-subtle); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.reply-share-dialog .reply-share-note { margin: 15px 2px 0; color: var(--ob-text-muted); font-size: 11px; line-height: 1.6; text-align: center; }
.reply-share-dialog button:disabled { opacity: .45; cursor: default; }
.reply-share-dialog button:focus-visible, .reply-share-trigger:focus-visible { outline: 2px solid var(--ob-blue); outline-offset: -3px; }
.reply-share-dialog button:active:not(:disabled) { background: var(--ob-hover); }
@media (hover: hover) and (pointer: fine) {
	.reply-share-dialog button:hover:not(:disabled) { background: var(--ob-hover); }
}
@media (max-width: 760px) {
	.reply-share-control { display: inline-flex; align-items: center; }
	.reply-share-trigger { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ob-text-muted); cursor: pointer; }
	.reply-share-trigger:active { background: var(--ob-hover); }
	.reply-share-modal .el-overlay-dialog { top: var(--mobile-viewport-top, 0px); bottom: auto; height: var(--mobile-viewport-height, 100%); box-sizing: border-box; align-items: flex-end; padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); }
}
@media (prefers-reduced-motion: reduce) {
	.reply-share-dialog, .reply-share-dialog button { transition: none; }
}
</style>

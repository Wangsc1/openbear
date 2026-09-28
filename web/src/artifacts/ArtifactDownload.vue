<script setup>
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from "vue";
import {installationEnvironment} from "../pwa/install.js";
import {artifactFromUrl, artifactRecord, loadArtifactMetadata} from "./artifactFiles.js";
import {readShareFile} from "./artifactDownload.js";

const props = defineProps({navigationKey: {type: String, default: ""}});
const shown = ref(false), state = ref("loading"), message = ref("");
const identity = shallowRef(null), file = shallowRef(null);
const ios = ref(false);
const shareLabel = computed(() => ios.value ? "存储到文件…" : "保存/分享…");
const fallbackLabel = computed(() => ios.value ? "在新窗口打开下载" : "直接下载");
let generation = 0, controller = null;

function close() {
	generation++;
	controller?.abort(); controller = null;
	file.value = null; identity.value = null; shown.value = false;
}
async function prepare(event) {
	const selected = artifactFromUrl(event.detail?.href);
	if (!selected) return;
	close();
	const current = generation;
	ios.value = installationEnvironment(window).ios;
	identity.value = selected; shown.value = true; state.value = "loading"; message.value = "正在准备原文件…";
	controller = new AbortController();
	const pending = controller;
	let timedOut = false;
	const timeout = setTimeout(() => { timedOut = true; pending.abort(); }, 60000);
	try {
		const metadata = await loadArtifactMetadata(artifactRecord(selected), {force: true});
		if (current !== generation) return;
		if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
			state.value = "browser"; message.value = `此设备不支持文件分享，请点“${fallbackLabel.value}”。`; return;
		}
		const result = await readShareFile(selected, metadata, {signal: controller.signal, onProgress(loaded, total) {
			if (current === generation && total > 0) message.value = `正在准备原文件… ${Math.min(99, Math.floor(loaded * 100 / total))}%`;
		}});
		if (current !== generation) return;
		if (!result) { state.value = "browser"; message.value = `文件超过 20 MB；请点“${fallbackLabel.value}”，避免占用过多手机内存。`; return; }
		if (!navigator.canShare({files: [result]})) {
			state.value = "browser"; message.value = `此设备不支持文件分享，请点“${fallbackLabel.value}”。`; return;
		}
		file.value = result; state.value = "ready";
		message.value = ios.value
			? "点“存储到文件…”打开系统分享面板，再选择“存储到文件”；不会自动分享给任何人。"
			: "原文件已准备好。点“保存/分享…”选择文件管理器、网盘等接收应用；是否有保存选项取决于已安装的应用，不会自动分享给任何人。";
	} catch (error) {
		if (current === generation && (timedOut || error?.name !== "AbortError")) {
			state.value = "error";
			message.value = timedOut ? "准备文件超时，请重试。" : (error?.message || "准备文件失败，请重试。");
		}
	} finally { clearTimeout(timeout); }
}
async function share() {
	if (state.value !== "ready" || !file.value) return;
	const current = generation;
	state.value = "sharing";
	try {
		// Must be invoked synchronously within this *new* button click.
		const promise = navigator.share({files: [file.value]});
		await promise;
		if (current === generation) message.value = ios.value
			? "系统分享面板已关闭；请确认文件已存储，或再次选择存储到文件。"
			: "系统面板已返回；请在所选应用中确认文件是否保存。这里无法确认保存结果，可再次点“保存/分享…”。";
	} catch (error) {
		if (current === generation) message.value = error?.name === "AbortError"
			? `已取消，可再次点“${shareLabel.value}”。`
			: `无法打开系统分享面板，请重试或点“${fallbackLabel.value}”。`;
	} finally { if (current === generation) state.value = "ready"; }
}
function directDownload() {
	if (!ios.value) message.value = "已交给系统下载，通常位于手机“下载 / Download”目录；网页无法确认是否保存成功。也可使用“保存/分享…”选择接收应用。";
}
watch(() => props.navigationKey, close);
onMounted(() => window.addEventListener("openbear:download-artifact", prepare));
onBeforeUnmount(() => { window.removeEventListener("openbear:download-artifact", prepare); close(); });
</script>

<template>
	<Teleport to="body">
	<section v-if="shown" class="artifact-download-sheet" role="dialog" aria-label="保存原文件">
		<div class="artifact-download-heading"><strong>保存原文件</strong><button type="button" aria-label="关闭保存文件提示" @click="close">关闭</button></div>
		<p role="status">{{ message }}</p>
		<div class="artifact-download-actions">
			<button v-if="state === 'ready' || state === 'sharing'" type="button" :disabled="state === 'sharing'" @click="share">{{ shareLabel }}</button>
			<button v-if="state === 'error'" type="button" @click="prepare({detail: {href: identity.contentUrl}})">重试</button>
			<a v-if="identity" :href="identity.downloadUrl" :target="ios ? '_blank' : undefined" :download="ios ? undefined : ''" rel="noopener noreferrer" @click="directDownload">{{ fallbackLabel }}</a>
		</div>
	</section>
	</Teleport>
</template>

<style>
.artifact-download-sheet { position: fixed; z-index: 3100; right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); left: max(12px, env(safe-area-inset-left)); max-width: 460px; margin: 0 auto; padding: 16px; border: 1px solid var(--ob-border); border-radius: 14px; background: var(--ob-surface-raised); color: var(--ob-text); box-shadow: var(--ob-shadow-dialog); }
.artifact-download-heading, .artifact-download-actions { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.artifact-download-sheet p { margin: 12px 0; line-height: 1.5; font-size: 13px; }
.artifact-download-sheet button, .artifact-download-sheet a { padding: 7px 11px; border: 1px solid var(--ob-border); border-radius: 7px; background: var(--ob-surface-soft); color: var(--ob-text-strong); font: inherit; font-size: 13px; text-decoration: none; cursor: pointer; }
.artifact-download-sheet button:disabled { opacity: .5; cursor: default; }
</style>

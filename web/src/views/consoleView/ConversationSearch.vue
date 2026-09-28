<script setup>
import {nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {Search, Hide, View} from '@element-plus/icons-vue';
import {Api, apiError} from '../../api.js';

const props = defineProps({conversationUuid: {type: String, default: ''}, open: {type: Boolean, default: false}});
const emit = defineEmits(['update:open', 'locate']);
const query = ref(''), includeHidden = ref(false), items = ref([]), nextCursor = ref(null);
const searching = ref(false), errorText = ref(''), previewId = ref(''), previewText = ref('');
const input = ref(null);
let generation = 0, previewGeneration = 0, debounce = 0;
function invalidate() { generation++; previewGeneration++; clearTimeout(debounce); searching.value = false; previewId.value = ''; previewText.value = ''; }
function close() { emit('update:open', false); }
function scheduleSearch() {
  invalidate(); items.value = []; nextCursor.value = null; errorText.value = '';
  if (query.value.trim()) debounce = setTimeout(() => { void search(); }, 240);
}
watch([query, includeHidden], scheduleSearch);
watch(() => props.conversationUuid, () => { invalidate(); query.value = ''; items.value = []; nextCursor.value = null; });
watch(() => props.open, async (open) => { if (open) { await nextTick(); input.value?.focus(); } else invalidate(); });
onBeforeUnmount(invalidate);
async function search(more = false) {
  const q = query.value.trim(), uuid = props.conversationUuid;
  if (!q || !uuid || searching.value || (more && !nextCursor.value)) return;
  const seq = ++generation;
  searching.value = true; errorText.value = '';
  try {
    const data = await Api.conversationSearch(uuid, {q, includeHidden: includeHidden.value, ...(more ? {cursor: nextCursor.value} : {})});
    if (seq !== generation || uuid !== props.conversationUuid || !props.open) return;
    items.value = more ? [...items.value, ...data.items] : data.items;
    nextCursor.value = data.nextCursor;
  } catch (error) { if (seq === generation) errorText.value = apiError(error); }
  finally { if (seq === generation) searching.value = false; }
}
async function preview(item) {
  if (previewId.value === item.opId) { previewGeneration++; previewId.value = ''; previewText.value = ''; return; }
  const seq = ++previewGeneration, uuid = props.conversationUuid;
  previewId.value = item.opId; previewText.value = '';
  try {
    const data = await Api.hiddenMessagePreview(uuid, item.opId);
    if (seq === previewGeneration && uuid === props.conversationUuid && props.open)
      previewText.value = String(data.operation?.payload?.text || '无文字内容');
  } catch (error) { if (seq === previewGeneration) { previewText.value = apiError(error); } }
}
function locate(item) { if (item.hidden) return; close(); emit('locate', item); }
function displayTime(value) { return value ? new Date(value).toLocaleString('zh-CN', {hour12: false}) : ''; }
</script>

<template>
  <el-drawer :model-value="open" @update:model-value="emit('update:open', $event)" title="搜索此会话" class="conversation-search-drawer mobile-viewport-drawer" direction="rtl" size="min(100vw, 390px)" append-to-body>
    <div class="conversation-search-panel">
      <label class="search-field"><Search aria-hidden="true"/><input ref="input" v-model="query" type="search" maxlength="200" placeholder="搜索用户消息与模型回复" aria-label="搜索此会话消息"/></label>
      <label class="search-hidden"><input v-model="includeHidden" type="checkbox"/>包含隐藏消息 <small>隐藏内容仅可单独预览</small></label>
      <p class="search-hint">搜索当前会话全部历史 · 仅正文，不含工具日志和思考内容</p>
      <div class="search-results" role="region" aria-label="搜索结果">
        <p v-if="errorText" class="search-info" role="alert">{{ errorText }}</p>
        <p v-else-if="!query.trim()" class="search-info">输入关键词开始搜索</p>
        <p v-else-if="!items.length && !searching" class="search-info">没有找到匹配消息</p>
        <article v-for="item in items" :key="item.opId" class="search-result">
          <div class="search-result-meta"><span>{{ item.type === 'user_message' ? '我的消息' : '模型回复' }}</span><time>{{ displayTime(item.createdAtMs) }}</time></div>
          <template v-if="item.hidden">
            <button class="search-result-link" type="button" :aria-expanded="previewId === item.opId" @click="preview(item)"><Hide/><span>隐藏消息 · {{ previewId === item.opId ? '收起预览' : '明确预览原文' }}</span><View/></button>
            <p v-if="previewId === item.opId" class="search-preview">{{ previewText || '正在读取…' }}<small>仅本机预览 · 未恢复显示</small></p>
          </template>
          <button v-else class="search-result-link" type="button" @click="locate(item)">{{ item.snippet }}</button>
        </article>
        <p v-if="searching" class="search-info" role="status">正在搜索…</p>
        <button v-if="nextCursor && !searching" type="button" class="search-more" @click="search(true)">加载更多结果</button>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.conversation-search-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--ob-chat-text); }
.search-field { display: flex; align-items: center; gap: 10px; border: 1px solid var(--ob-chat-line); border-radius: 9px; padding: 0 12px; background: var(--ob-chat-bg); }
.search-field:focus-within { outline: 2px solid var(--ob-blue); outline-offset: 2px; }
.search-field svg { width: 17px; height: 17px; flex: none; color: var(--ob-chat-subtle); }
.search-field input { width: 100%; min-width: 0; height: 44px; border: 0; outline: none; background: transparent; color: inherit; font-size: 16px; }
.search-hidden { display: flex; align-items: center; gap: 8px; min-height: 44px; font-size: 13px; cursor: pointer; }
.search-hidden input { width: 17px; height: 17px; accent-color: var(--ob-blue); }
.search-hidden small { margin-left: auto; color: var(--ob-chat-subtle); font-size: 11px; }
.search-hint { margin: 0 0 8px; color: var(--ob-chat-subtle); font-size: 11px; line-height: 1.6; }
.search-results { flex: 1; overflow-y: auto; min-height: 0; }
.search-info { padding: 24px 8px; text-align: center; color: var(--ob-chat-subtle); font-size: 13px; }
.search-result { border-top: 1px solid var(--ob-chat-line); padding: 13px 2px; }
.search-result-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ob-chat-subtle); font-size: 11px; }
.search-result-meta span { color: var(--ob-chat-muted); font-weight: 600; }
.search-result-link { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 44px; margin-top: 4px; padding: 7px; border: 0; border-radius: 7px; background: transparent; color: var(--ob-chat-text); text-align: left; line-height: 1.55; font-size: 13px; overflow-wrap: anywhere; cursor: pointer; }
.search-result-link:hover, .search-result-link:focus-visible { background: var(--ob-chat-selected); }
.search-result-link svg { width: 15px; height: 15px; flex: none; }
.search-preview { margin: 4px 7px 0; padding: 10px; border: 1px dashed var(--ob-chat-line); border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.search-preview small { display: block; margin-top: 8px; color: var(--ob-chat-subtle); font-size: 11px; }
.search-more { width: 100%; min-height: 44px; border: 1px solid var(--ob-chat-line); border-radius: 8px; background: var(--ob-chat-bg); color: var(--ob-chat-text); cursor: pointer; }
</style>

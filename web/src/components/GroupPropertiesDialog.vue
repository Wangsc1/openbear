<script setup>
import {computed, reactive, ref, watch} from 'vue';
import {ElMessage, ElMessageBox} from 'element-plus';
import {Api, apiError} from '../api.js';
import GroupEditor from '../views/consoleView/GroupEditor.vue';
import {changedPaths, cloneProposal, validateProposal} from '../views/consoleView/groupProposal.js';
import './conversationTreeProperties.css';

const props = defineProps({modelValue: Boolean, groupId: {type: String, default: ''}});
const emit = defineEmits(['update:modelValue']);
const loading = ref(false), saving = ref(false), error = ref(''), errors = ref({});
const group = ref(null), models = ref([]);
const original = ref(cloneProposal({}));
const draft = reactive(cloneProposal({}));
const removed = computed(() => (group.value?.members || []).filter(member => member.status !== 'active'));
const changed = computed(() => changedPaths(original.value, draft));
const dirty = computed(() => changed.value.size > 0);
let generation = 0;

function adopt(data) {
  group.value = data;
  const value = cloneProposal({...data, members: (data.members || []).filter(member => member.status === 'active')});
  original.value = cloneProposal(value);
  Object.assign(draft, value);
  errors.value = {};
}
async function load() {
  const run = ++generation;
  if (!props.modelValue || !props.groupId) return;
  loading.value = true; error.value = '';
  try {
    const data = await Api.collabGroup(props.groupId);
    if (run !== generation) return;
    models.value = data.models || [];
    adopt(data.group);
  } catch (e) { if (run === generation) error.value = apiError(e); }
  finally { if (run === generation) loading.value = false; }
}
watch(() => [props.modelValue, props.groupId], load, {immediate: true});

function clearError(path) {
  if (!errors.value[path]) return;
  const next = {...errors.value}; delete next[path]; errors.value = next;
}
async function save() {
  const found = validateProposal(draft, 'update', models.value);
  errors.value = found;
  if (Object.keys(found).length) return;
  saving.value = true;
  try {
    const data = await Api.updateCollabGroup(props.groupId, {revision: group.value.revision, group: JSON.parse(JSON.stringify(draft))});
    adopt(data.group);
    ElMessage.success(data.changes?.length ? '已保存；主会话和相关成员会在下一轮看到改动' : '没有改动');
  } catch (e) {
    const status = Number(e?.response?.status || 0);
    if (status === 409) { ElMessage.warning('小组设定已在别处修改，已重新载入'); await load(); }
    else ElMessage.error(apiError(e));
  } finally { saving.value = false; }
}
async function restore(member) {
  try {
    const data = await Api.restoreCollabMember(member.conversationUuid);
    adopt(data.group);
    ElMessage.success(`已恢复成员「${member.name}」`);
  } catch (e) { ElMessage.error(apiError(e)); }
}
async function close(done) {
  if (saving.value) return;
  if (dirty.value) {
    try { await ElMessageBox.confirm('有未保存的修改，关闭后会丢失。', '放弃修改？', {confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning'}); }
    catch { return; }
  }
  emit('update:modelValue', false);
  if (typeof done === 'function') done();
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="小组属性" width="min(820px, calc(100vw - 24px))" append-to-body class="folder-properties-dialog mobile-viewport-dialog group-properties-dialog" :before-close="close" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
    <template #header>
      <div class="folder-properties-heading">
        <h2 :title="group?.name">{{ group?.name || '小组属性' }}</h2>
      </div>
    </template>
    <div v-loading="loading" class="property-form group-property-form">
      <p v-if="error" class="group-property-error" role="alert">{{ error }} <el-button link @click="load">重试</el-button></p>
      <template v-else-if="group">
        <p class="group-property-scope">{{ group.leadTitle ? `主会话「${group.leadTitle}」 · ` : '' }}这里只能修改字段，增减成员请告诉主会话</p>
        <GroupEditor :draft="draft" :models="models" :errors="errors" :changed="changed" :disabled="saving"
                     :member-rules="group.memberRules || ''" @clear-error="clearError"/>
        <section v-if="removed.length" class="group-removed">
          <h3>已移除的成员</h3>
          <div v-for="member in removed" :key="member.conversationUuid" class="group-removed-row">
            <span>{{ member.name }}</span>
            <el-button link :disabled="saving" @click="restore(member)">恢复</el-button>
          </div>
        </section>
      </template>
    </div>
    <template #footer>
      <div class="property-footer">
        <span class="property-footer-note">{{ dirty ? '修改会通知主会话，被改的成员下一轮刷新设定' : '' }}</span>
        <div class="property-footer-buttons">
          <el-button :disabled="saving" @click="close">关闭</el-button>
          <el-button type="primary" :loading="saving" :disabled="!dirty || loading" @click="save">保存</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.group-property-form { display: grid; gap: .6rem; min-height: 8rem; }
.group-property-error { font-size: 13px; color: var(--ob-danger); }
.group-property-scope { margin: 0; font-size: 12px; color: var(--fp-secondary); }
.group-removed { display: grid; gap: .35rem; border-top: 1px solid var(--ob-border); padding-top: .6rem; }
.group-removed h3 { margin: 0; font-size: 12px; font-weight: 650; color: var(--ob-text-subtle); }
.group-removed-row { display: flex; align-items: center; justify-content: space-between; gap: .5rem; font-size: 13px; }
.group-property-form :deep(.group-editor) { --ob-interaction-surface-strong: var(--ob-surface); --ob-interaction-border-strong: var(--ob-blue); --ob-interaction-ink: var(--ob-text); --ob-interaction-muted: var(--ob-text-subtle); --ob-interaction-focus: var(--ob-focus); --ob-interaction-accent-soft: var(--ob-blue-soft); --ob-interaction-accent-strong: var(--ob-blue); }
</style>

<script setup>
import { ref } from 'vue';
import ServerForm from './ServerForm.vue';
import { serverLabel } from './instanceHelpers.js';

// The "添加服务器…" entry opens the server dialog on top of the current one,
// so the surrounding form keeps what was already filled in.
const props = defineProps({modelValue: {type: String, default: ''}, servers: {type: Array, required: true}, label: {type: String, default: '运行位置'}});
const emit = defineEmits(['update:modelValue', 'added']);
const adding = ref(false), formRef = ref(null), select = ref(null);
function change(event) {
  if (event.target.value === '__add') {
    event.target.value = props.modelValue;
    adding.value = true;
    return;
  }
  emit('update:modelValue', event.target.value);
}
function saved(server) {
  adding.value = false;
  emit('added', server);
  emit('update:modelValue', server.id);
}
function close(done) { if (!formRef.value?.busy) done(); }
</script>
<template>
  <select ref="select" :value="modelValue" :aria-label="label" @change="change">
    <option v-for="server in servers" :key="server.id" :value="server.id">{{ serverLabel(server) }}</option>
    <option value="__add">添加服务器…</option>
  </select>
  <el-dialog v-model="adding" title="添加服务器" width="500px" class="admin-dialog instance-dialog instance-ui" append-to-body destroy-on-close :close-on-click-modal="false" :before-close="close">
    <ServerForm v-if="adding" ref="formRef" @saved="saved" @cancel="adding = false" />
  </el-dialog>
</template>

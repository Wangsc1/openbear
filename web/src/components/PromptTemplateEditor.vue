<script setup>
import AdaptiveMdEditor from './AdaptiveMdEditor.vue';
defineOptions({inheritAttrs: false});
const props = defineProps({modelValue: {type: String, default: ''}, readOnly: Boolean, mobileFlow: Boolean, square: Boolean, completionRoots: {type: Array, default: null}});
const emit = defineEmits(['update:modelValue']);
function update(value) { if (!props.readOnly) emit('update:modelValue', value); }
</script>

<template>
  <AdaptiveMdEditor :model-value="modelValue" :read-only="readOnly" :mobile-flow="mobileFlow" :square="square" language="markdown" completion-mode="template" :completion-roots="completionRoots" @update:model-value="update" />
</template>

<script setup>
import {useId} from 'vue';
import {nullableNumber} from './webhookConfig.js';
const props = defineProps({modelValue: [String, Number, Boolean], label: String, hint: String, unit: String, type: {type: String, default: 'text'}, nullable: Boolean, required: Boolean, filterable: Boolean, placeholder: String, error: String, disabled: Boolean, min: Number, max: Number, step: [Number, String], path: String, options: Array});
const emit = defineEmits(['update:modelValue', 'blur']);
const id = `webhook-${useId()}`;
function update(event) { emit('update:modelValue', props.type === 'number' ? (event.target.validity?.badInput ? NaN : nullableNumber(event.target.value)) : event.target.value); }
</script>
<template>
  <div class="wh-field" :data-field="path" :class="{'has-error': error}" @focusout="emit('blur')">
    <label :for="id">{{ label }}<span v-if="required" class="wh-required" aria-hidden="true"> *</span></label>
    <div class="wh-field-value">
      <slot :id="id">
        <el-select v-if="options" :id="id" :model-value="modelValue" :disabled="disabled" :placeholder="placeholder" :filterable="filterable" :aria-required="required" :aria-describedby="`${id}-hint`" :aria-invalid="Boolean(error)" @update:model-value="emit('update:modelValue', $event)">
          <el-option v-for="option in options" :key="String(option.value)" :value="option.value" :label="option.label" />
        </el-select>
        <input v-else :id="id" :value="modelValue ?? ''" :type="type" :disabled="disabled" :required="required" :placeholder="placeholder || (nullable ? '留空' : '')" :min="min" :max="max" :step="step ?? (type === 'number' ? 'any' : undefined)" :aria-describedby="`${id}-hint`" :aria-invalid="Boolean(error)" @input="update" />
      </slot>
      <span v-if="unit" class="wh-unit">{{ unit }}</span>
    </div>
    <small :id="`${id}-hint`" :class="{'wh-error-text': error}">{{ error || hint }}</small>
  </div>
</template>

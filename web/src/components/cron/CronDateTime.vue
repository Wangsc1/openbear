<script setup>
import {computed} from 'vue';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import Field from '../webhooks/WebhookField.vue';
import {pickerDate,pickerIso} from './cronConfig.js';
const props=defineProps({modelValue:String,label:String,hint:String,error:String,disabled:Boolean,placeholder:String});
const emit=defineEmits(['update:modelValue']);
const selected=computed({get:()=>pickerDate(props.modelValue),set:value=>emit('update:modelValue',pickerIso(value))});
</script>
<template>
  <Field :label="label" :hint="hint" :error="error" v-slot="{id}">
    <el-config-provider :locale="zhCn">
      <el-date-picker :id="id" v-model="selected" type="datetime" format="YYYY-MM-DD HH:mm:ss" :placeholder="placeholder || '选择日期和时间'" :disabled="disabled" :editable="false" :aria-describedby="`${id}-hint`" :aria-invalid="Boolean(error)" clearable />
    </el-config-provider>
  </Field>
</template>

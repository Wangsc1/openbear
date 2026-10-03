<script setup>
import {ref, watch} from 'vue';
import WebhookField from './WebhookField.vue';
import {clone, parseLines} from './webhookConfig.js';
const props = defineProps({modelValue: Boolean, statistics: Object});
const emit = defineEmits(['update:modelValue', 'apply']);
const draft = ref({dimensions: [], metricDefinitions: [], businessFields: []});
watch(() => props.modelValue, open => { if (open) draft.value = clone(props.statistics); });
function apply() { emit('apply', clone(draft.value)); emit('update:modelValue', false); }
</script>
<template>
  <el-dialog :model-value="modelValue" title="配置统计口径" width="min(780px, calc(100vw - 24px))" append-to-body class="mobile-viewport-dialog wh-stat-config" :close-on-click-modal="false" @update:model-value="emit('update:modelValue', $event)">
    <p>应用后仍需保存属性，仅影响新事件。query.appname 对应地址中的 ?appname=订单通知；用户／消息 ID 应作为明细，避免海量常驻分组。取消不会改变原草稿。</p>
    <h3>统计维度</h3>
    <section v-for="(dimension,index) in draft.dimensions" :key="index" class="wh-section">
      <div class="wh-form-grid">
        <WebhookField v-model="dimension.name" label="维度名称" placeholder="来源" /><WebhookField v-model="dimension.path" label="取值路径" placeholder="query.appname" />
        <WebhookField v-model="dimension.kind" label="字段用途" :options="[{value:'category',label:'类别：用于汇总'}, {value:'identifier',label:'标识符：业务明细'}, {value:'text',label:'文本：留存和检索'}]" />
        <WebhookField v-model="dimension.missing" label="字段缺失时" :options="[{value:'omit',label:'不汇总此字段'}, {value:'unknown',label:'记录为未知类别'}, {value:'rejectMetric',label:'拒绝此项指标并保留事件'}]" />
        <WebhookField v-model="dimension.maxLength" type="number" :step="1" label="字段值最大长度" unit="字符" />
        <WebhookField v-if="dimension.kind === 'category'" v-model="dimension.maxCategories" type="number" :step="1" label="最多汇总多少种类别" unit="类" hint="超限只降级聚合，不丢业务事件。" />
        <WebhookField :model-value="(dimension.allowedValues || []).join(', ')" label="限定类别（可选）" hint="逗号分隔，留空不限定具体值。" @update:model-value="dimension.allowedValues = parseLines($event)" />
      </div>
      <el-button link type="danger" @click="draft.dimensions.splice(index,1)">移除维度</el-button>
    </section>
    <el-button size="small" @click="draft.dimensions.push({name:'',path:'',kind:'category',missing:'omit',maxLength:128,maxCategories:100})">添加维度</el-button>
    <h3>自定义指标</h3><p>业务操作数由脚本／模型报告，不是平台独立验证。已使用名称的类型、单位、标签和分桶不能重解释；改变契约请用新名称。</p>
    <section v-for="(metric,index) in draft.metricDefinitions" :key="index" class="wh-section">
      <div class="wh-form-grid">
        <WebhookField v-model="metric.name" label="指标名称" placeholder="custom_actions_total" />
        <WebhookField v-model="metric.type" label="指标类型" :options="[{value:'counter',label:'Counter：非负增量'}, {value:'gauge',label:'Gauge：时点观测'}, {value:'histogram',label:'Histogram：观测分布'}]" />
        <WebhookField v-model="metric.unit" label="计量单位" placeholder="次 / 秒 / MB" /><WebhookField v-model="metric.description" label="指标说明" />
        <WebhookField :model-value="metric.allowedLabels.join(', ')" label="允许的分类标签" hint="逗号分隔；不要使用每条消息的 ID。" @update:model-value="metric.allowedLabels = parseLines($event)" />
        <WebhookField v-if="metric.type === 'gauge'" v-model="metric.gaugeStaleSeconds" type="number" label="多久没有新观测就过期" unit="秒" hint="过期显示 stale，不变成 0。" />
        <WebhookField v-if="metric.type === 'histogram'" :model-value="(metric.histogramBuckets || []).join(', ')" label="严格递增的分桶边界" placeholder="0.1, 0.5, 1, 5" hint="末尾无穷大桶由框架提供。" @update:model-value="metric.histogramBuckets = parseLines($event).map(Number)" />
      </div><el-button link type="danger" @click="draft.metricDefinitions.splice(index,1)">移除定义</el-button>
    </section>
    <el-button size="small" @click="draft.metricDefinitions.push({name:'custom_',type:'counter',unit:'',description:'',allowedLabels:[],gaugeStaleSeconds:300,histogramBuckets:[]})">添加指标定义</el-button>
    <h3>可查询业务明细字段</h3>
    <section v-for="(field,index) in draft.businessFields" :key="index" class="wh-section"><div class="wh-form-grid">
      <WebhookField v-model="field.name" label="名称" /><WebhookField v-model="field.path" label="取值路径" placeholder="body.sender_id" />
      <WebhookField v-model="field.valueType" label="值类型" :options="[{value:'string',label:'文本'}, {value:'number',label:'数字'}, {value:'boolean',label:'是／否'}]" />
      <el-checkbox v-model="field.queryable">允许筛选和排行</el-checkbox>
    </div><el-button link type="danger" @click="draft.businessFields.splice(index,1)">移除字段</el-button></section>
    <el-button size="small" @click="draft.businessFields.push({name:'',path:'',valueType:'string',queryable:true})">添加业务字段</el-button>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" @click="apply">应用到草稿</el-button></template>
  </el-dialog>
</template>

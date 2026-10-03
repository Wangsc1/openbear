<script setup>
import WebhookField from './WebhookField.vue';
import AdaptiveMdEditor from '../AdaptiveMdEditor.vue';
import {parseLines, endpointLimit, bytesToMb, mbToBytes} from './webhookConfig.js';
const props = defineProps({config:{type:Object,required:true},environment:{type:Object,default:()=>({})},errors:{type:Array,default:()=>[]},schemaText:String,schemaError:String});
const emit = defineEmits(['schema-change']);
const errorFor = path => props.errors.find(item=>item.path===path)?.message;
const limits = [
  ['requestsPerMinute','每分钟接收上限','条/分钟','限制这个入口一分钟接收多少请求；适合避免某个来源占满系统。'],
  ['pendingEvents','待处理事件上限','条','尚未处理完的事件最多保留多少条；满后新请求会被拒绝。'],
  ['pendingBytes','待处理内容上限','MB','尚未处理完的内容最多占多少空间；不是模型上下文大小。'],
  ['preConcurrency','前置脚本同时运行','个','同时检查或处理新消息的脚本数量。'],
  ['postConcurrency','后置脚本同时运行','个','同时处理完成结果的脚本数量。'],
  ['autoModelConcurrency','自动会话同时运行','个','同时运行的自动模型任务数；固定会话始终逐个处理。'],
];
function limitHint(field,note) {
  const info=endpointLimit(props.environment,props.config,field),format=value=>value==null?'未提供':field==='pendingBytes'?`${bytesToMb(value)} MB`:value;
  return `${note} 留空直接继承系统 ${format(info.maximum)}；当前有效 ${format(info.effective)}。`;
}
function limitValue(field) { return field==='pendingBytes'?bytesToMb(props.config.limits[field]):props.config.limits[field]; }
function setLimit(field,value) { props.config.limits[field]=field==='pendingBytes'?mbToBytes(value):value; }
</script>
<template>
  <div class="wh-form-scroll">
    <section class="wh-section"><h3>单独限制这个入口</h3><p>通常保持空白即可，所有入口仍共同受系统总限制。这里仅用于给某个来源设置更小的额度。</p><div class="wh-form-grid"><WebhookField v-for="[field,label,unit,note] in limits" :key="field" :model-value="limitValue(field)" @update:model-value="setLimit(field,$event)" :path="`limits.${field}`" type="number" :step="field==='pendingBytes'?'any':1" nullable :label="label" :unit="unit" :error="errorFor(`limits.${field}`)" :hint="limitHint(field,note)" /></div><p>容量单位：1 MB = 1024 × 1024 字节，可填写小数，保存时换算为整数个字节。</p></section>
    <section class="wh-section"><h3>避免重复处理同一条消息</h3><p>发送方重试请求时，请使用相同的 Idempotency-Key 请求头。例如订单通知第一次未收到响应，重发同一 ID 和完全相同的内容，不会再次处理。没有稳定 ID 时，每次请求都是新消息。</p><WebhookField v-model="config.idempotency.bodyIdPath" label="消息 ID 在正文中的位置（可选）" placeholder="body.event_id" hint="例如正文有 event_id，可填 body.event_id。仅在没有 Idempotency-Key 时读取；填了但消息里找不到该字段，会拒收。" /></section>
    <section class="wh-section"><h3>关联同一业务，避免自己触发自己</h3><p>仅在对接系统需要时填写。例如用订单号识别同一笔业务；把自己发出的回调标记为 openbear，可避免反复触发。</p><div class="wh-form-grid"><WebhookField v-model="config.correlation.idPath" label="业务编号的位置" placeholder="body.order_id" hint="提取关联标识供后续处理使用，不会自动把不同消息合并或去重。" /><WebhookField v-model="config.correlation.originPath" path="correlation.originPath" label="消息来源标识的位置" placeholder="body.origin" :error="errorFor('correlation.originPath')" /></div><el-checkbox v-model="config.correlation.ignoreOwnEcho">不处理由我自己发出的回调</el-checkbox><WebhookField v-if="config.correlation.ignoreOwnEcho" :model-value="config.correlation.ownOriginValues.join(', ')" label="代表自己的来源值" placeholder="openbear" hint="例如 body.origin 的值是 openbear；多个值用逗号分隔，只有完全相同才忽略。" @update:model-value="config.correlation.ownOriginValues=parseLines($event)" /></section>
    <section class="wh-section"><h3>调整发给模型的消息格式</h3><p>通常留空，由系统整理消息。只有希望固定展示顺序或格式时才填写模板；可使用 trigger、batch、events、conversation，不会执行消息正文中的模板内容。</p><p>例如：在模板开头写“请先核对订单信息”，再使用 <code>[[ events ]]</code> 展示事件。</p><div class="wh-small-editor"><AdaptiveMdEditor :model-value="config.processing.eventTemplate || ''" language="markdown" completion-mode="none" @update:model-value="config.processing.eventTemplate=$event || null" /></div></section>
    <section class="wh-section"><h3>要求模型返回固定格式</h3><p>后置脚本需要明确字段时，可用 JSON Schema 检查模型结果。留空不做这个检查。例如要求结果必须包含字符串 status：</p><pre class="wh-example">{"type":"object","properties":{"status":{"type":"string"}},"required":["status"]}</pre><WebhookField :model-value="schemaText" path="processing.resultSchema" label="结果格式要求（JSON Schema）" :error="schemaError" hint="这里只校验返回格式，不证明外部操作成功。" @update:model-value="emit('schema-change',$event)" /></section>
    <section class="wh-section"><h3>处理完成后如何通知</h3><WebhookField v-model="config.notifications.policy" label="通知方式" :options="[{value:'inherit',label:'使用已有通知渠道'},{value:'errorsDigest',label:'把异常合并成一条摘要'},{value:'silent',label:'不主动通知，只保留处理记录'}]" hint="摘要适合频繁触发的来源，避免每个异常单独打扰；需要你确认的操作仍会提示。" /><WebhookField v-model="config.notifications.digestSeconds" path="notifications.digestSeconds" type="number" nullable :step="1" :min="1" :max="3600" :error="errorFor('notifications.digestSeconds')" label="异常合并间隔" unit="秒" hint="例如 60 表示将一分钟内的异常集中通知；留空使用系统设置。" /></section>
    <slot />
  </div>
</template>

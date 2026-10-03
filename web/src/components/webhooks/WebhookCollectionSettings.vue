<script setup>
import WebhookField from './WebhookField.vue';
import {bytesToMb, mbToBytes} from './webhookConfig.js';
const props = defineProps({config: {type: Object, required: true}, environment: {type: Object, default: () => ({})}, errors: {type: Array, default: () => []}});
const errorFor = path => props.errors.find(item => item.path === path)?.message;
</script>
<template>
  <div class="wh-form-scroll">
    <section class="wh-section">
      <h3>批量处理</h3>
      <el-switch v-model="config.batching.enabled" active-text="启用批量收集" />
      <p>以下条件取“或”：先满足任意一个就结束收集。到点只代表封批，会话忙或达到容量时仍需排队。关闭后每条有效事件一批，也不会打断当前会话。</p>
      <div class="wh-form-grid">
        <WebhookField v-model="config.batching.idleSeconds" path="batching.idleSeconds" type="number" nullable label="多久没有新事件就开始处理" unit="秒" :disabled="!config.batching.enabled" :error="errorFor('batching.idleSeconds')" hint="例如连续 3 秒没有新消息后开始处理；留空不用这个条件。" />
        <WebhookField v-model="config.batching.maxWaitSeconds" path="batching.maxWaitSeconds" type="number" nullable label="一批最多收集多久" unit="秒" :disabled="!config.batching.enabled" :error="errorFor('batching.maxWaitSeconds')" hint="从第一条有效事件入桶计时；持续有消息也不会无限等。留空不用这个条件。" />
        <WebhookField v-model="config.batching.maxEvents" path="batching.maxEvents" type="number" :step="1" :min="1" label="一批最多多少条" unit="条" :disabled="!config.batching.enabled" :error="errorFor('batching.maxEvents')" :hint="`达到数量就开始排队处理；系统硬上限 ${environment.limits?.batching?.maxBatchEvents ?? '—'} 条。`" />
        <WebhookField :model-value="bytesToMb(config.batching.maxBytes)" @update:model-value="config.batching.maxBytes = mbToBytes($event)" path="batching.maxBytes" type="number" step="any" :min="0" label="一批内容最多多大" unit="MB" :error="errorFor('batching.maxBytes')" :hint="`1 MB = 1024 × 1024 字节；系统上限 ${bytesToMb(environment.limits?.batching?.maxBatchBytes) ?? '—'} MB。超出大小的事件留待处理，不截断。`" />
      </div>
    </section>
    <section class="wh-section">
      <h3>事件有效期</h3>
      <WebhookField v-model="config.expiry.ttlSeconds" path="expiry.ttlSeconds" type="number" nullable label="超过多久不再继续处理" unit="秒" :error="errorFor('expiry.ttlSeconds')" hint="留空 = 不过期。过期只阻止尚未开始的阶段，不撤销已完成动作，不强杀执行中的阶段。同一 ID 重投不续期。" />
      <div v-if="config.expiry.ttlSeconds != null" class="wh-form-grid">
        <WebhookField v-model="config.expiry.basis" label="从什么时间开始计算" :options="[{value:'receivedAt',label:'服务器首次持久接收'}, {value:'sourceField',label:'事件中的指定时间字段'}]" />
        <WebhookField v-model="config.expiry.onExpired" label="过期后如何保留" :options="[{value:'expire',label:'标记过期，不继续'}, {value:'needsReview',label:'保留为待人工核实'}]" />
        <template v-if="config.expiry.basis === 'sourceField'">
          <WebhookField v-model="config.expiry.timestampPath" path="expiry.timestampPath" label="时间字段路径" placeholder="body.created_at" :error="errorFor('expiry.timestampPath')" />
          <WebhookField v-model="config.expiry.sourceTimeFormat" label="源时间格式" :options="[{value:'rfc3339',label:'RFC3339（必须带时区）'}, {value:'unixSeconds',label:'Unix 秒（不是毫秒）'}]" />
          <WebhookField v-model="config.expiry.missingTimestamp" label="源时间缺失或无效时" :options="[{value:'hold',label:'保留，等待核实'}, {value:'useReceivedAt',label:'改用服务器接收时间并记录原因'}]" />
          <WebhookField v-model="config.expiry.maxFutureSkewSeconds" type="number" label="允许源时间领先服务器" unit="秒" :min="0" :error="errorFor('expiry.maxFutureSkewSeconds')" />
        </template>
      </div>
    </section>
  </div>
</template>

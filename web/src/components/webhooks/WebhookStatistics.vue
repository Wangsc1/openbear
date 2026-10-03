<script setup>
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {Api} from '../../api.js';
import WebhookStatisticsConfig from './WebhookStatisticsConfig.vue';
import WebhookEventDialog from './WebhookEventDialog.vue';
import {statusLabel, tabKey, EVENT_STATES} from './webhookConfig.js';
const props = defineProps({endpointId: String, scopeType: String, scopeId: String, statistics: Object, editable: Boolean, global: Boolean});
const emit = defineEmits(['update:statistics']);
const tabs = [['overview','概览'],['phases','阶段耗时'],['events','事件记录'],['business','业务统计']];
const tab = ref('overview'), days = ref(1), stateFilter = ref(''), data = ref(null), events = ref([]);
const loading = ref(false), error = ref(''), nextCursor = ref(null), currentCursor = ref(null), previousCursors = ref([]);
const configOpen = ref(false), eventId = ref(''), eventOpen = ref(false), businessView = ref('business'), rankingField = ref('');
const queryFields = ref([]), filterField = ref(''), filterValue = ref(''), appliedFilters = ref({}), filterError = ref('');
const activeFilterField = computed(() => queryFields.value.find(field => field.name === filterField.value));
let generation = 0, abort, schemaEndpoint = null, range = null;
const levels = {event:'事件',batch:'批次',assignment:'整轮任务',attempt:'执行尝试',call:'物理调用'};
const bucketRows = buckets => (buckets?.bounds || []).map((bound,index) => ({le:bound == null ? '+∞' : bound,count:buckets.cumulative?.[index]}));
const overview = computed(() => data.value?.overview);
const fmt = value => value == null ? '—' : typeof value === 'number' ? value.toLocaleString('zh-CN', {maximumFractionDigits: 4}) : value;
const time = value => value ? new Date(value).toLocaleString('zh-CN', {hour12: false}) : '—';
const usageFields = [['inputTokens','未缓存输入 Tokens'],['outputTokens','输出 Tokens'],['cacheReadTokens','缓存读 Tokens'],['cacheWriteTokens','缓存写 Tokens'],['costUsd','有证据费用小计 USD'],['providerReportedCostUsd','提供方实报 USD'],['estimatedCostUsd','本地估算 USD'],['unclassifiedCostUsd','来源未分类 USD']];
const coverageLabel = value => ({complete:'完整',projected:'原账本已删除，使用可追溯投影',incomplete:'计费证据缺失，非完整总量',partial:'部分缺失',unavailable:'证据不可用'})[value] || '未说明';
const warningLabel = value => ({original_ledger_deleted:'原调用账本已删除，保留的统计投影不是第二份收费账本',missing_billing_evidence:'历史计费证据缺失，不得当作零费用',estimated_cost:'包含本地估算，不是提供方实报',unclassified_cost_source:'部分金额来源未分类'})[value] || (value.startsWith('retention_gap:') ? `保留策略造成历史证据缺口：${value.slice(14)}` : value);
async function load(cursor = null) {
  const run = ++generation; abort?.abort(); abort = new AbortController(); data.value = null; error.value = '';
  if (!props.global && !props.endpointId) { loading.value = false; return false; }
  loading.value = true;
  if (!range) { const end = new Date(); range = {start: new Date(end.getTime() - days.value * 86400000).toISOString(), end: end.toISOString()}; }
  const params = {endpointId: props.endpointId, scopeType: props.scopeType || undefined, scopeId: props.scopeId || undefined, ...range, limit: 30, cursor};
  try {
    if (tab.value === 'business' && props.endpointId && schemaEndpoint !== props.endpointId) {
      const detail = await Api.webhook(props.endpointId, {signal: abort.signal});
      if (run !== generation) return false;
      queryFields.value = (detail.endpoint?.config?.statistics?.businessFields || []).filter(field => field.queryable);
      schemaEndpoint = props.endpointId;
    }
    // A blank ranking selector is an unfinished query, not a failed server request.
    const rankingPending = tab.value === 'business' && businessView.value === 'ranking' && !rankingField.value;
    const value = rankingPending && props.endpointId ? {items:[]} : tab.value === 'events'
      ? await Api.webhookEvents({...params, state: stateFilter.value || undefined}, {signal: abort.signal})
      : await Api.webhookStatistics({...params, view: rankingPending ? 'business' : tab.value === 'business' ? businessView.value : tab.value, field: rankingField.value || undefined,
        filters: tab.value === 'business' && businessView.value === 'business' && Object.keys(appliedFilters.value).length ? JSON.stringify(appliedFilters.value) : undefined}, {signal: abort.signal});
    if (run !== generation) return false;
    if (Array.isArray(value.queryableFields)) queryFields.value = value.queryableFields;
    data.value = rankingPending ? {...value,items:[],nextCursor:null} : value; events.value = data.value.items || []; nextCursor.value = data.value.nextCursor || null; currentCursor.value = cursor;
    return true;
  } catch (exception) { if (run === generation && !abort.signal.aborted) error.value = exception?.response?.data?.message || exception.message || '查询失败'; return false; }
  finally { if (run === generation) loading.value = false; }
}
function resetQuery() { range = null; previousCursors.value = []; return load(); }
function refresh() { schemaEndpoint = null; return resetQuery(); }
function applyFilter() {
  filterError.value = '';
  const field = activeFilterField.value;
  if (!field) { filterError.value = '请选择已声明可查询的字段'; return; }
  let value = filterValue.value;
  if (field.valueType === 'number') {
    if (String(value).trim() === '' || !Number.isFinite(Number(value))) { filterError.value = '筛选值需为有效数字'; return; }
    value = Number(value);
  } else if (field.valueType === 'boolean') {
    if (![true,false,'true','false'].includes(value)) { filterError.value = '请选择是或否'; return; }
    value = value === true || value === 'true';
  }
  appliedFilters.value = {...appliedFilters.value,[field.name]:value};
}
function removeFilter(name) { const next = {...appliedFilters.value}; delete next[name]; appliedFilters.value = next; }
function clearFilters() { rankingField.value = ''; filterField.value = ''; appliedFilters.value = {}; }
watch(filterField, () => { filterValue.value = ''; filterError.value = ''; });
watch(() => [props.endpointId, props.scopeType, props.scopeId], () => { schemaEndpoint = null; queryFields.value = []; rankingField.value = ''; filterField.value = ''; appliedFilters.value = {}; });
watch(() => [props.endpointId, props.scopeType, props.scopeId, props.global, tab.value, days.value, stateFilter.value, businessView.value, rankingField.value, appliedFilters.value], resetQuery, {immediate: true});
onBeforeUnmount(() => { generation++; abort?.abort(); });
function inspect(id) { eventId.value = id; eventOpen.value = true; }
async function nextPage() { if (loading.value || !nextCursor.value) return; const previous = currentCursor.value; if (await load(nextCursor.value)) previousCursors.value.push(previous); }
async function previousPage() { if (loading.value || !previousCursors.value.length) return; if (await load(previousCursors.value.at(-1))) previousCursors.value.pop(); }
async function navigate(event) { const target = event.currentTarget; tab.value = tabKey(event, tab.value, tabs); await nextTick(); target?.querySelector(`[data-tab="${tab.value}"]`)?.focus(); }
</script>
<template>
  <div class="wh-statistics wh-form-scroll">
    <div class="wh-editor-toolbar"><nav class="wh-inline-tabs" role="tablist" aria-label="统计分类" @keydown="navigate"><button v-for="[id,label] in tabs" :key="id" role="tab" :data-tab="id" :aria-selected="tab === id" :tabindex="tab === id ? 0 : -1" @click="tab = id">{{ label }}</button></nav><span class="wh-toolbar-spacer" /><el-select v-model="days" aria-label="统计时间范围" class="wh-range"><el-option :value="1" label="最近 24 小时" /><el-option :value="7" label="最近 7 天" /><el-option :value="30" label="最近 30 天" /></el-select><el-button link :disabled="loading" @click="refresh">刷新</el-button></div>
    <p v-if="!endpointId && !global" class="wh-empty">保存入口后显示真实统计。当前没有事件样本，不以演示数据代替。</p>
    <div v-else-if="loading" role="status"><el-skeleton :rows="5" animated /></div>
    <div v-else-if="error" class="wh-alert" role="alert">{{ error }}<el-button @click="load(currentCursor)">重试查询</el-button><el-button v-if="tab === 'business' && (rankingField || Object.keys(appliedFilters).length)" @click="clearFilters">清除查询条件</el-button></div>
    <template v-else-if="data">
      <p v-for="warning in data.warnings || []" :key="warning" class="wh-warning">{{ warningLabel(warning) }}</p><p v-if="data.range?.coverageStatus && data.range.coverageStatus !== 'complete'" class="wh-warning">历史覆盖：{{ coverageLabel(data.range.coverageStatus) }}。下方仅表示仍有证据的样本，空值或零不代表没有业务。</p><details v-if="data.range?.gaps?.length"><summary>历史证据缺口</summary><p v-for="(gap,index) in data.range.gaps" :key="index">{{ gap.kind }} · {{ time(gap.start) }} → {{ time(gap.end) }} · {{ gap.endpointId }}</p></details><p v-if="data.fieldConflicts?.length" class="wh-warning">同名业务字段的类型或取值路径不一致：{{ data.fieldConflicts.map(item => item.name).join('、') }}。这些字段不混合排行，请在总览选择具体入口查看。</p>
      <p v-if="data.range?.coverageStatus === 'unavailable'" class="wh-empty">此范围历史证据不可用，无法判定业务数量、费用或耗时；不展示为零。</p>
      <template v-else>
      <template v-if="tab === 'overview' && overview">
        <div class="wh-kpi-grid"><div v-for="[field,label] in [['accepted','唯一事件'],['modelBatches','模型批次'],['modelCalls','物理模型调用']]" :key="field" class="wh-kpi"><span>{{ label }}</span><b>{{ fmt(overview[field]) }}</b></div></div>
        <p>事件数、批次数与物理调用数不同。一次批次可能调用模型多次；费用不伪装成逐事件真实成本。</p>
        <section class="wh-section"><h3>接收与阶段尝试</h3><dl class="wh-value-grid"><div v-for="[field,label] in [['requests','HTTP 请求'],['rejected','拒绝'],['duplicates','重复请求'],['preAttempts','前置尝试'],['preContinue','交给模型'],['preHandled','脚本报告完成'],['preIgnored','脚本忽略'],['postAttempts','后置尝试']]" :key="field"><dt>{{ label }}</dt><dd>{{ fmt(overview[field]) }}</dd></div></dl></section>
        <section class="wh-section"><h3>队列与阻塞</h3><dl class="wh-value-grid"><div v-for="(value, key) in overview.queue || {}" :key="key"><dt>{{ statusLabel(key) }}</dt><dd>{{ fmt(value) }}</dd></div></dl><p>最早待处理事件：{{ time(overview.oldestPendingAt) }}</p></section>
        <section class="wh-section"><h3>唯一模型调用用量</h3><dl class="wh-value-grid"><div v-for="[field,label] in usageFields" :key="field"><dt>{{ label }}</dt><dd>{{ fmt(overview.usage?.[field]) }}</dd></div><div><dt>缓存命中率</dt><dd>{{ overview.usage?.cacheHitRate == null ? '—（无样本）' : `${fmt(overview.usage.cacheHitRate * 100)}%` }}</dd></div></dl><p v-if="overview.usage?.unknownUsageCalls || overview.usage?.unknownCostCalls" class="wh-warning">用量未知 {{ fmt(overview.usage?.unknownUsageCalls) }} 次，费用未知 {{ fmt(overview.usage?.unknownCostCalls) }} 次；已知小计不是完整总量。</p><p>计费证据：{{ coverageLabel(overview.usage?.coverage) }}。实报 {{ fmt(overview.usage?.costSources?.providerReported) }} 次；估算 {{ fmt(overview.usage?.costSources?.estimated) }} 次；来源未分类 {{ fmt(overview.usage?.costSources?.unclassified) }} 次；费用未知 {{ fmt(overview.usage?.costSources?.unknown) }} 次。</p><p v-if="overview.usage?.ledgerDeletedCalls" class="wh-warning">原账本已删除 {{ fmt(overview.usage.ledgerDeletedCalls) }} 次；金额仍由可追溯统计投影保留。</p><p v-if="overview.usage?.missingLedgerCalls" class="wh-warning">历史计费证据缺失 {{ fmt(overview.usage.missingLedgerCalls) }} 次；不得将其当作零费用。</p><p v-for="warning in overview.usage?.warnings || []" :key="warning" class="wh-warning">{{ warningLabel(warning) }}</p><p>缓存读 ÷（未缓存输入 + 缓存读 + 缓存写），先汇总再计算。跨入口续接只关联原轮，不重复计费；人工发起的等待不重算历史调用。</p></section>
      </template>
      <template v-else-if="tab === 'phases'"><p>人工／外部等待与模型执行分开。共享批次的耗时不按事件数重复累加；分位数采用原始分布或标注的桶估计。</p><div class="wh-table-scroll"><table><thead><tr><th>阶段</th><th>计量单位</th><th>样本数</th><th>平均（秒）</th><th>P50</th><th>P95</th><th>最大</th><th>精度</th></tr></thead><tbody><tr v-for="item in data.phases || []" :key="`${item.phase}:${item.measurementLevel}`"><td>{{ item.label || item.phase }}</td><td>{{ levels[item.measurementLevel] || item.measurementLevel || '—' }}</td><td>{{ fmt(item.count) }}</td><td>{{ fmt(item.averageSeconds) }}</td><td>{{ fmt(item.p50Seconds) }}</td><td>{{ fmt(item.p95Seconds) }}</td><td>{{ fmt(item.maxSeconds) }}</td><td>{{ item.precision || '—' }}</td></tr></tbody></table></div><p v-if="!data.phases?.length" class="wh-empty">此范围没有阶段耗时样本。</p></template>
      <template v-else-if="tab === 'events'"><div class="wh-editor-toolbar"><el-select v-model="stateFilter" clearable placeholder="全部处理状态" aria-label="处理状态筛选"><el-option v-for="value in EVENT_STATES" :key="value" :label="statusLabel(value)" :value="value" /></el-select><span>时间按当前时区显示。</span></div><div class="wh-table-scroll"><table><thead><tr><th>事件</th><th>接收时间</th><th>规则</th><th>阶段／结果</th><th>操作</th></tr></thead><tbody><tr v-for="item in events" :key="item.eventId"><td><code>{{ item.eventId }}</code></td><td>{{ time(item.receivedAt) }}</td><td>v{{ item.receivedRevision }}</td><td>{{ statusLabel(item.state) }}<small>{{ item.reason }}</small></td><td><el-button link @click="inspect(item.eventId)">查看详情</el-button></td></tr></tbody></table></div><p v-if="!events.length" class="wh-empty">此范围没有事件。</p></template>
      <template v-else-if="tab === 'business'"><div class="wh-editor-toolbar"><h3>业务报告</h3><span class="wh-toolbar-spacer" /><el-button v-if="editable" @click="configOpen = true">配置统计口径</el-button></div><p>以下为脚本／模型声明，不是框架独立证明业务成功。缺报显示“—”，不填成 0。测试记录默认不计入生产排行。</p><div class="wh-actions"><el-select v-model="businessView" aria-label="业务查询类型"><el-option value="business" label="业务明细" /><el-option value="metrics" label="自定义指标" /><el-option value="ranking" label="字段排行" /></el-select><el-select v-if="businessView === 'ranking'" v-model="rankingField" placeholder="选择已声明可查询字段" aria-label="排行字段"><el-option v-for="field in queryFields" :key="field.name" :value="field.name" :label="field.name" /></el-select></div>
        <div v-if="businessView === 'business'" class="wh-section"><h3>按业务字段筛选</h3><p>使用已保存、允许查询的字段；多个条件同时满足。筛选不会修改统计规则。</p><div class="wh-actions"><el-select v-model="filterField" clearable placeholder="选择字段" aria-label="业务筛选字段"><el-option v-for="field in queryFields" :key="field.name" :value="field.name" :label="field.name" /></el-select><el-select v-if="activeFilterField?.valueType === 'boolean'" v-model="filterValue" placeholder="选择是或否" aria-label="业务筛选值"><el-option :value="true" label="是" /><el-option :value="false" label="否" /></el-select><el-input v-else v-model="filterValue" :type="activeFilterField?.valueType === 'number' ? 'number' : 'text'" placeholder="字段值（精确匹配）" aria-label="业务筛选值" @keyup.enter="applyFilter" /><el-button :disabled="!activeFilterField || loading" @click="applyFilter">应用筛选</el-button></div><p v-if="filterError" class="wh-error-text" role="alert">{{ filterError }}</p><p v-if="!queryFields.length">当前范围没有已声明的可查询字段。</p><div class="wh-actions"><el-tag v-for="(value,name) in appliedFilters" :key="name" closable @close="removeFilter(name)">{{ name }} = {{ value }}</el-tag></div></div><p v-if="businessView === 'ranking' && !rankingField" class="wh-muted">请选择已保存的排行字段；没有可查询字段时，请先配置统计口径。</p>
        <div class="wh-table-scroll"><table v-if="businessView === 'metrics'"><thead><tr><th>指标</th><th>类型／单位</th><th>值</th><th>状态／观测时间</th></tr></thead><tbody><tr v-for="item in data.metrics || []" :key="`${item.endpointId || endpointId}:${item.name}:${JSON.stringify(item.labels)}`"><td>{{ item.name }}<small v-if="!endpointId">入口 {{ item.endpointId }} · {{ item.scope?.type }} / {{ item.scope?.id }}</small><small>{{ item.labels }}</small></td><td>{{ item.type }} / {{ item.unit }}</td><td><template v-if="item.coverage === 'unavailable'">—（历史证据不可用）</template><template v-else-if="item.type === 'histogram'">样本 {{ fmt(item.count) }} · 总和 {{ fmt(item.sum) }}<small>最小 {{ fmt(item.min) }} / 最大 {{ fmt(item.max) }}</small><small>P50 {{ fmt(item.p50) }} / P95 {{ fmt(item.p95) }}（{{ item.precision === 'bucketApproximation' ? '桶估计' : '原始样本' }}）</small><details><summary>查看累计分桶</summary><dl><div v-for="bucket in bucketRows(item.buckets)" :key="bucket.le"><dt>≤ {{ bucket.le }}</dt><dd>{{ fmt(bucket.count) }}</dd></div></dl></details></template><template v-else>{{ fmt(item.type === 'gauge' ? item.lastValue : item.sum) }}</template></td><td><small v-if="item.coverage && item.coverage !== 'complete'">{{ coverageLabel(item.coverage) }}</small><small v-for="warning in item.warnings || []" :key="warning">{{ warningLabel(warning) }}</small>{{ item.stale ? '已过期（不是零）' : item.precision || '业务报告' }}<small>{{ time(item.lastObservedAt) }}</small></td></tr></tbody></table>
          <table v-else><thead><tr><th>{{ businessView === 'ranking' ? '字段值' : '业务事件' }}</th><th>{{ businessView === 'ranking' ? '报告条数' : '业务字段' }}</th><th>来源／时间</th></tr></thead><tbody><tr v-for="(item,index) in data.items || []" :key="item.recordId || item.id || index"><td>{{ item.event ?? item.eventType ?? item.value }}<small v-if="!endpointId">{{ item.endpointId ? `入口 ${item.endpointId}` : (item.endpointIds || []).join('、') }}</small></td><td><pre v-if="businessView !== 'ranking'">{{ JSON.stringify(item.fields,null,2) }}</pre><span v-else>{{ fmt(item.count) }}</span></td><td>{{ item.source || '业务声明' }}<small>{{ time(item.observedAt) }}</small></td></tr></tbody></table></div><p v-if="!(data.metrics?.length || data.items?.length)" class="wh-empty">此范围没有业务报告，不代表业务操作数为零。</p>
      </template>
      <div v-if="tab === 'events' || tab === 'business'" class="wh-pagination"><el-button :disabled="loading || !previousCursors.length" @click="previousPage">上一页</el-button><el-button :disabled="loading || !nextCursor" @click="nextPage">下一页</el-button></div>
      </template>
      <p v-if="data.range" class="wh-muted">可用数据起点 {{ time(data.range.coverageStart) }} · 汇总分辨率 {{ fmt(data.range.resolutionSeconds) }} 秒</p>
    </template>
    <el-button v-if="editable && tab === 'business' && !data" @click="configOpen = true">配置统计口径</el-button>
    <WebhookStatisticsConfig v-model="configOpen" :statistics="statistics" @apply="emit('update:statistics', $event)" />
    <WebhookEventDialog v-model="eventOpen" :event-id="eventId" />
  </div>
</template>

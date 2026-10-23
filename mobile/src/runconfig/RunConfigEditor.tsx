/**
 * 运行配置编辑器（主会话 / Agent 两组：模型、思考强度、Fast；上下文压缩策略）。
 * 输入区工作包 B3 实现；目录属性、临时会话属性、会话属性（B1）复用同一个组件。
 *
 * 约定的接口（B3 实现时保持不变，B1 只按此接口调用）：
 * - value：当前配置；inherited：继承来源的配置（目录/全局默认），用于显示“继承”状态；
 * - allowInherit：是否允许每项选“继承”（目录属性用；会话里不允许）；
 * - onChange(patch)：一次只改一项，调用方负责保存（会话里串行保存，目录里随属性一起保存）；
 * - 模型列表由编辑器自己通过当前服务器的 GET /api/rath/options 读取，调用方不用传。
 *
 * 取值约定（实现说明）：
 * - contextStrategy 输出服务端取值 'model_summary' / 'sliding_window'（读取时也接受 'summary' / 'sliding'）。
 * - 会话里（allowInherit=false）：agentModel / agentThinkLevel 为 '' 表示“跟随主会话”，agentFastMode 为 null 表示“跟随”。
 * - allowInherit=true 时每项多一个“继承”，选中时调用 onChange({字段: undefined})（与 B1 目录属性的保存约定一致）；
 *   value 里的 null / undefined 都显示为“继承”。Agent 的“跟随主会话”仍输出 ''（Fast 的“跟随”与“继承”合并为“继承”）。
 * - 可选 props（B3 加的，不影响 B1 的调用）：running（运行中提示）、saving（保存中禁用压缩策略并显示指示）、
 *   tab / onTabChange（受控标签）、footer（标签内容之后的附加区，例如输入区的“立即压缩”与用量）。
 *
 * 布局：手机上设置（思考、Fast、压缩策略）在上、模型列表在下；模型列表按渠道分组、可搜索、选中打勾，
 * 每个模型带特性标签，点“ⓘ”就地展开详情（Web 为悬停浮层）。编辑器本身不滚动，调用方放进 SheetScroll / ScrollView。
 */
import { Brain, Check, ChevronDown, ChevronUp, Info, Layers, RefreshCw, Zap, type LucideIcon } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Icon, Press, tap } from '../ui/primitives';
import { SearchField } from '../ui/conversations/ListControls';
import { type Theme, useTheme } from '../ui/theme';
import {
  SLIDING,
  SUMMARY,
  findModel,
  groupModels,
  modelDefaultThinking,
  modelFeatures,
  modelLabel,
  modelShortLabel,
  modelTags,
  modelThinkingLevels,
  normalizeStrategy,
  strategyLabel,
  thinkLabel,
  type ModelInfo,
  type RunConfig,
} from './logic';
import { useModelOptions } from './options';

export type { RunConfig } from './logic';

export type RunConfigEditorProps = {
  value: RunConfig;
  inherited?: RunConfig;
  allowInherit?: boolean;
  disabled?: boolean;
  onChange(patch: Partial<RunConfig>): void;
  testID?: string;
  /** 会话正在运行：显示“下一轮生效 / 用于新 Agent”提示 */
  running?: boolean;
  /** 有修改正在保存（压缩策略保存中禁用） */
  saving?: boolean;
  tab?: 'main' | 'agent';
  onTabChange?(tab: 'main' | 'agent'): void;
  footer?: React.ReactNode;
};

const isSet = (v: unknown) => v !== null && v !== undefined;

export function RunConfigEditor({ value, inherited = {}, allowInherit = false, disabled, onChange, testID, running, saving, tab: tabProp, onTabChange, footer }: RunConfigEditorProps) {
  const theme = useTheme();
  const options = useModelOptions();
  const [tabState, setTabState] = useState<'main' | 'agent'>('main');
  const tab = tabProp || tabState;
  const setTab = (next: 'main' | 'agent') => {
    setTabState(next);
    onTabChange?.(next);
  };
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState('');
  const models = options.models;

  // 生效值：本级未设置时用继承值
  const pick = <K extends keyof RunConfig>(key: K) => (allowInherit && !isSet(value[key]) ? inherited[key] : value[key]);
  const mainModelKey = String(pick('model') || '');
  const mainInfo = findModel(models, mainModelKey);
  const agentRaw = pick('agentModel');
  const agentModelKey = String(agentRaw || '') || mainModelKey;
  const agentInfo = findModel(models, agentModelKey);
  const isAgent = tab === 'agent';
  const groups = useMemo(() => groupModels(models, query), [models, query]);

  const change = (patch: Partial<RunConfig>) => {
    if (disabled) return;
    tap('select');
    onChange(patch);
  };

  // ---- 思考强度 ----
  const levels = modelThinkingLevels(isAgent ? agentInfo : mainInfo);
  const thinkKey: keyof RunConfig = isAgent ? 'agentThinkLevel' : 'thinkLevel';
  const ownThink = value[thinkKey];
  const effectiveThink = String(pick(thinkKey) || '');
  const thinkItems: SegItem[] = [];
  if (allowInherit) thinkItems.push({ key: '__inherit', label: '继承' });
  if (isAgent) thinkItems.push({ key: '__follow', label: '跟随' });
  for (const level of levels) thinkItems.push({ key: level, label: thinkLabel(level) });
  const thinkSelected = allowInherit && !isSet(ownThink) ? '__inherit' : isAgent && !effectiveThink ? '__follow' : effectiveThink || modelDefaultThinking(isAgent ? agentInfo : mainInfo);
  const defaultThink = modelDefaultThinking(isAgent ? agentInfo : mainInfo);
  const thinkHint = !levels.length
    ? '未声明支持'
    : isAgent
      ? effectiveThink
        ? '未跟随主会话'
        : `跟随：${thinkLabel(String(pick('thinkLevel') || modelDefaultThinking(mainInfo)))}`
      : `默认 ${defaultThink ? thinkLabel(defaultThink) : '无'}`;
  const onThink = (key: string) => {
    if (key === '__inherit') change({ [thinkKey]: undefined });
    else if (key === '__follow') change({ [thinkKey]: '' });
    else change({ [thinkKey]: key });
  };

  // ---- Fast ----
  const mainFastSupported = Boolean(mainInfo?.supportsFast);
  const agentFastSupported = Boolean(agentInfo?.supportsFast);
  const agentFast = pick('agentFastMode');
  const agentFastKey = allowInherit && !isSet(value.agentFastMode) ? '__inherit' : agentFast === true ? 'on' : agentFast === false ? 'off' : '__follow';

  // ---- 压缩策略 ----
  const ownStrategy = normalizeStrategy(value.contextStrategy);
  const strategyKey = allowInherit && !ownStrategy ? '__inherit' : ownStrategy || normalizeStrategy(inherited.contextStrategy) || SLIDING;

  const selectedModel = isAgent ? (allowInherit && !isSet(value.agentModel) ? '__inherit' : String(value.agentModel || '')) : allowInherit && !isSet(value.model) ? '__inherit' : mainModelKey;

  const summary = [
    levels.length ? `思考 ${thinkSelected === '__inherit' ? '继承' : thinkSelected === '__follow' ? '跟随' : thinkLabel(thinkSelected)}` : '思考未声明',
    isAgent
      ? `Fast ${{ __inherit: '继承', __follow: '跟随', on: '开', off: '关' }[agentFastKey]}`
      : `Fast ${mainFastSupported ? (pick('fastMode') ? '开' : '关') : '不支持'}`,
    strategyKey === '__inherit' ? '压缩继承' : strategyLabel(strategyKey),
  ].join(' · ');

  return (
    <View testID={testID} style={styles.root} pointerEvents={disabled ? 'none' : 'auto'}>
      <View style={styles.pad}>
        <Seg theme={theme} items={[{ key: 'main', label: '主会话' }, { key: 'agent', label: 'Agent' }]} value={tab} onChange={(k) => setTab(k as 'main' | 'agent')} testID="runcfg-tab" />
        <Text numberOfLines={2} style={[styles.summary, { color: theme.muted }]} testID="runcfg-summary">
          {summary}
          {running ? ` · ${isAgent ? '模型与执行设置用于新 Agent' : '主模型在下一轮运行生效'}` : ''}
        </Text>
      </View>

      {/* 思考强度 */}
      <Section theme={theme} icon={Brain} title="思考强度" hint={thinkHint}>
        {thinkItems.length ? <Seg theme={theme} items={thinkItems} value={thinkSelected} onChange={onThink} testID="runcfg-think" /> : null}
      </Section>

      {/* Fast */}
      {isAgent ? (
        <Section theme={theme} icon={Zap} title="Fast 模式" hint={agentFastSupported ? `跟随时当前为${pick('fastMode') && agentFastSupported ? '开启' : '关闭'}` : '当前 Agent 模型未声明 Fast 能力'}>
          <Seg
            theme={theme}
            items={[
              ...(allowInherit ? [{ key: '__inherit', label: '继承' }] : [{ key: '__follow', label: '跟随' }]),
              { key: 'on', label: '开', disabled: !agentFastSupported },
              { key: 'off', label: '关' },
            ]}
            value={allowInherit && agentFastKey === '__follow' ? '__inherit' : agentFastKey}
            onChange={(k) => change({ agentFastMode: k === 'on' ? true : k === 'off' ? false : k === '__inherit' ? undefined : null })}
            testID="runcfg-agent-fast"
          />
        </Section>
      ) : allowInherit ? (
        <Section theme={theme} icon={Zap} title="Fast 模式" hint={mainFastSupported ? `继承：${inherited.fastMode ? '开' : '关'}` : '当前模型不支持'}>
          <Seg
            theme={theme}
            items={[{ key: '__inherit', label: '继承' }, { key: 'on', label: '开', disabled: !mainFastSupported }, { key: 'off', label: '关' }]}
            value={!isSet(value.fastMode) ? '__inherit' : value.fastMode ? 'on' : 'off'}
            onChange={(k) => change({ fastMode: k === '__inherit' ? undefined : k === 'on' })}
            testID="runcfg-fast"
          />
        </Section>
      ) : (
        <View style={styles.switchRow} testID="runcfg-fast">
          <Icon as={Zap} size={16} color={theme.subtle} strokeWidth={1.9} />
          <View style={styles.flex}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Fast 模式</Text>
            <Text style={[styles.hint, { color: theme.muted }]}>{mainFastSupported ? (value.fastMode ? '已开启' : '已关闭') : '当前模型不支持'}</Text>
          </View>
          <Switch
            value={Boolean(value.fastMode) && mainFastSupported}
            disabled={!mainFastSupported || disabled}
            onValueChange={(v) => change({ fastMode: v })}
            trackColor={{ true: theme.button, false: theme.surfaceSoft }}
            thumbColor={theme.dark ? (value.fastMode ? theme.buttonText : theme.subtle) : theme.panel}
            accessibilityLabel="Fast 模式"
            testID="runcfg-fast-switch"
          />
        </View>
      )}

      {/* 压缩策略（主会话与 Agent 共用） */}
      <Section theme={theme} icon={Layers} title="上下文压缩" hint={saving ? '保存中…' : '主会话与 Agent 共用，在下一个安全边界生效'}>
        <Seg
          theme={theme}
          items={[
            ...(allowInherit ? [{ key: '__inherit', label: `继承${normalizeStrategy(inherited.contextStrategy) ? `（${strategyLabel(inherited.contextStrategy)}）` : ''}` }] : []),
            { key: SUMMARY, label: '模型摘要', disabled: saving },
            { key: SLIDING, label: '滑动窗口', disabled: saving },
          ]}
          value={strategyKey}
          onChange={(k) => change({ contextStrategy: k === '__inherit' ? undefined : k })}
          testID="runcfg-strategy"
        />
      </Section>

      {footer}

      {/* 模型 */}
      <View style={[styles.pad, styles.modelHead]}>
        <Text style={[styles.groupTitle, { color: theme.muted }]}>{isAgent ? 'Agent 模型' : '模型'}</Text>
        {options.loading ? <ActivityIndicator size="small" color={theme.muted} /> : null}
      </View>
      <View style={styles.pad}>
        <SearchField theme={theme} value={query} onChange={setQuery} placeholder={isAgent ? '搜索 Agent 模型' : '搜索模型'} testID="runcfg-search" />
      </View>
      {options.error ? (
        <Pressable onPress={options.reload} style={styles.errorRow} accessibilityRole="button" testID="runcfg-models-retry">
          <Text style={[styles.hint, { color: theme.danger, flex: 1 }]}>模型列表读取失败：{options.error}</Text>
          <Icon as={RefreshCw} size={16} color={theme.danger} />
          <Text style={[styles.hint, { color: theme.danger }]}>重试</Text>
        </Pressable>
      ) : null}
      {allowInherit ? (
        <ModelRow theme={theme} label="继承" detailText={isAgent ? inheritedAgentText(inherited, models) : inherited.model ? labelOf(models, inherited.model) : '未设置'} selected={selectedModel === '__inherit'} onPress={() => change(isAgent ? { agentModel: undefined } : { model: undefined })} testID="runcfg-model-inherit" />
      ) : null}
      {isAgent ? (
        <ModelRow theme={theme} label="跟随主模型" detailText={mainInfo ? modelShortLabel(mainInfo) : mainModelKey || '—'} selected={selectedModel === ''} onPress={() => change({ agentModel: '' })} testID="runcfg-model-follow" />
      ) : null}
      {groups.map((group) => (
        <View key={group.provider}>
          <Text style={[styles.provider, { color: theme.muted }]} numberOfLines={1}>
            {group.provider}
          </Text>
          {group.models.map((model) => (
            <ModelRow
              key={model.key}
              theme={theme}
              model={model}
              label={modelLabel(model)}
              selected={selectedModel === model.key}
              expanded={detail === model.key}
              onToggleDetail={() => setDetail((d) => (d === model.key ? '' : model.key))}
              onPress={() => change(isAgent ? { agentModel: model.key } : { model: model.key })}
              testID={`runcfg-model-${model.key}`}
            />
          ))}
        </View>
      ))}
      {options.loaded && !groups.length ? <Text style={[styles.empty, { color: theme.muted }]}>没有匹配模型</Text> : null}
      {!options.loaded && !options.error ? <Text style={[styles.empty, { color: theme.muted }]}>正在读取模型…</Text> : null}
    </View>
  );
}

function labelOf(models: ModelInfo[], key: unknown) {
  const info = findModel(models, String(key || ''));
  return info ? modelShortLabel(info) : String(key || '—');
}

function inheritedAgentText(inherited: RunConfig, models: ModelInfo[]) {
  if (!isSet(inherited.agentModel)) return '未设置';
  return inherited.agentModel ? labelOf(models, inherited.agentModel) : '跟随主模型';
}

function Section({ theme, icon, title, hint, children }: { theme: Theme; icon: LucideIcon; title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Icon as={icon} size={16} color={theme.subtle} strokeWidth={1.9} />
        <Text style={[styles.sectionTitle, { color: theme.text }]}>{title}</Text>
        <View style={styles.flex} />
        {hint ? (
          <Text numberOfLines={1} style={[styles.hint, styles.hintRight, { color: theme.muted }]}>
            {hint}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

type SegItem = { key: string; label: string; disabled?: boolean };

/** 分段选择（与共享 Segmented 同样式，支持禁用单项与 testID）。 */
export function Seg({ theme, items, value, onChange, testID }: { theme: Theme; items: SegItem[]; value: string; onChange(key: string): void; testID?: string }) {
  return (
    <View style={[styles.seg, { backgroundColor: theme.hover }]} testID={testID}>
      {items.map((item) => {
        const on = item.key === value;
        return (
          <Pressable
            key={item.key}
            disabled={item.disabled}
            onPress={() => !on && onChange(item.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled: Boolean(item.disabled) }}
            accessibilityLabel={item.label}
            testID={testID ? `${testID}-${item.key}` : undefined}
            style={[styles.segItem, on && { backgroundColor: theme.dark ? theme.raised : theme.panel, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 }, item.disabled && { opacity: 0.4 }]}
          >
            <Text numberOfLines={1} style={[styles.segText, { color: on ? theme.textStrong : theme.subtle, fontWeight: on ? '600' : '400' }]}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ModelRow({ theme, model, label, detailText, selected, expanded, onToggleDetail, onPress, testID }: {
  theme: Theme;
  model?: ModelInfo;
  label: string;
  detailText?: string;
  selected: boolean;
  expanded?: boolean;
  onToggleDetail?: () => void;
  onPress(): void;
  testID?: string;
}) {
  const tags = model ? modelTags(model) : [];
  return (
    <View>
      <Press
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={model ? `${label}（${model.key}）` : label}
        testID={testID}
        style={[styles.modelRow, selected && { backgroundColor: theme.selected }]}
      >
        <View style={styles.flex}>
          <Text numberOfLines={1} style={[styles.modelName, { color: theme.textStrong, fontWeight: selected ? '600' : '400' }]}>
            {label}
          </Text>
          {detailText ? (
            <Text numberOfLines={1} style={[styles.hint, { color: theme.muted }]}>
              {detailText}
            </Text>
          ) : null}
          {tags.length ? (
            <View style={styles.tags}>
              {tags.map((tag) => (
                <View key={tag.id} style={[styles.tag, { backgroundColor: theme.hover }]}>
                  {tag.feature ? <Icon as={tag.feature === 'brain' ? Brain : Zap} size={11} color={theme.subtle} strokeWidth={2} /> : null}
                  <Text style={[styles.tagText, { color: theme.subtle }]}>{tag.label}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
        {selected ? <Icon as={Check} size={18} color={theme.textStrong} strokeWidth={2.2} /> : null}
        {model && onToggleDetail ? (
          <Pressable onPress={onToggleDetail} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${label} 详情`} style={styles.info} testID={testID ? `${testID}-info` : undefined}>
            <Icon as={expanded ? ChevronUp : Info} size={17} color={theme.muted} strokeWidth={1.9} />
          </Pressable>
        ) : null}
      </Press>
      {model && expanded ? (
        <View style={[styles.detail, { backgroundColor: theme.surfaceSoft }]} testID={testID ? `${testID}-detail` : undefined}>
          <Text style={[styles.detailKey, { color: theme.muted, marginBottom: 4 }]} numberOfLines={1}>
            {model.key}
          </Text>
          {modelFeatures(model).map((f) => (
            <View key={f.id} style={styles.detailRow}>
              <Text style={[styles.detailKey, { color: theme.muted }]}>{f.label}</Text>
              <Text style={[styles.detailValue, { color: theme.text }]}>{f.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// 保留未使用的导入以便将来扩展时不需要再改头部
void ChevronDown;

const styles = StyleSheet.create({
  // 平板/宽屏：限宽居中，避免分段控件和模型行被拉成整屏宽
  root: { paddingBottom: 8, width: '100%', maxWidth: 720, alignSelf: 'center' },
  flex: { flex: 1, minWidth: 0 },
  pad: { paddingHorizontal: 16 },
  summary: { fontSize: 12.5, lineHeight: 17, marginTop: 8, marginBottom: 2 },
  section: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 22 },
  sectionTitle: { fontSize: 14.5, fontWeight: '500' },
  hint: { fontSize: 12.5, lineHeight: 17 },
  hintRight: { flexShrink: 1, textAlign: 'right' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12, minHeight: 48 },
  seg: { flexDirection: 'row', borderRadius: 10, padding: 2 },
  segItem: { flex: 1, minHeight: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  segText: { fontSize: 13.5 },
  modelHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 18, paddingBottom: 8 },
  groupTitle: { fontSize: 12.5, fontWeight: '500', flex: 1 },
  provider: { fontSize: 12, fontWeight: '500', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 52, paddingVertical: 8, paddingLeft: 20, paddingRight: 8, marginHorizontal: 6, borderRadius: 12 },
  modelName: { fontSize: 15 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 20, paddingHorizontal: 6, borderRadius: 6 },
  tagText: { fontSize: 11 },
  info: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  detail: { marginHorizontal: 20, marginBottom: 6, borderRadius: 10, padding: 10, gap: 3 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  detailKey: { fontSize: 12.5 },
  detailValue: { fontSize: 12.5, fontWeight: '500' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingVertical: 10 },
  empty: { textAlign: 'center', paddingVertical: 20, fontSize: 13 },
});

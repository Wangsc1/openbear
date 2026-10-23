/**
 * 引用选择器（B3-12～B3-17）：输入 @ 后出现在输入卡片上方的面板（不打断输入法，键盘保持弹出）。
 * - 搜索词就是输入框里 @ 后面的文字（`@mem/`、`@doc/`、`@secret/`、`@chat/`、`@rec/` 限定类型时不显示分类）；
 * - 分类：全部 / 记忆 / 文档 / 凭证 / 会话 / 推荐 / 历史；引用模式：引用内容 / 仅提及；
 * - 会话行“消息 ›”进入该会话的问答/消息目录（GET /api/reference-history/{cid}）：整轮“引用整轮”，
 *   消息可多选（最多 30 条），面板内有自己的搜索框；“历史”标签直接列当前会话；
 * - 底部“包含已归档”开关（全局 WS resync includeArchived）；目录未连接/同步中显示状态点；
 * - 选中项按服务端上限执行 sizePolicy（超长自动降为“仅提及”并标出原因），与 Web 相同。
 * 外接键盘：Enter 插入高亮项（由输入区检测硬件 Enter 后调用 chooseHighlighted），返回键/Esc 关闭。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BookText, Brain, Check, ChevronLeft, FileText, KeyRound, MessageSquare, MessageSquareText, RotateCcw, Star, X, type LucideIcon } from 'lucide-react-native';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { useOpenBearApi } from '../runconfig/options';
import { apiError } from '../transport/apiAdapter';
import { Icon, Press, tap } from '../ui/primitives';
import type { Theme } from '../ui/theme';
import { Seg } from '../runconfig/RunConfigEditor';
import { KIND_LABELS, applyConversationPolicy, normalizeReference, policyReasonText, type Ref } from './draftModel';
import {
  acceptReferenceSizes,
  conversationMessages,
  referenceCandidateDetail,
  referencePolicyOptions,
  searchReferences,
  setIncludeArchived,
  useReferenceCatalog,
} from './catalogStore';

export const KIND_ICONS: Record<string, LucideIcon> = { mem: Brain, doc: FileText, secret: KeyRound, chat: MessageSquare, turn: RotateCcw, message: MessageSquareText, rec: Star };
const TABS: [string, string][] = [['', '全部'], ['mem', '记忆'], ['doc', '文档'], ['secret', '凭证'], ['chat', '会话'], ['rec', '推荐'], ['history', '历史']];

export type ReferencePanelHandle = { chooseHighlighted(): boolean };

type Props = {
  theme: Theme;
  query: string;
  kind: string;
  currentConversation: string;
  selectedRefs: Ref[];
  onSelect(refs: Ref[]): void;
  onClose(): void;
  maxHeight?: number;
};

export const ReferencePanel = forwardRef<ReferencePanelHandle, Props>(function ReferencePanel({ theme, query, kind, currentConversation, selectedRefs, onSelect, onClose, maxHeight = 320 }, ref) {
  const api = useOpenBearApi();
  const catalog = useReferenceCatalog();
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<'content' | 'mention'>('content');
  const [child, setChild] = useState<any>(null);
  const [childQuery, setChildQuery] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectionError, setSelectionError] = useState('');
  const [history, setHistory] = useState<{ rows: any[]; items: any[]; more: boolean; offset: number; busy: boolean; error: string }>({ rows: [], items: [], more: false, offset: 0, busy: false, error: '' });
  const generation = useRef(0);

  const activeKind = kind || filter;
  const historyMode = Boolean(child) || activeKind === 'history';

  const loadHistory = useCallback(
    async (target: any, append: boolean, prev = history) => {
      const id = target?.id || currentConversation;
      if (!id) {
        setHistory((h) => ({ ...h, busy: false, error: '先选择一个已有会话，再选择其中的问答或消息' }));
        return;
      }
      if (!api) return;
      const current = ++generation.current;
      setHistory((h) => ({ ...h, busy: true, error: '' }));
      try {
        const data: any = await api.referenceHistory(id, append ? prev.offset : 0);
        if (current !== generation.current) return;
        acceptReferenceSizes(data.items || [], data.conversationContentLimit);
        const rows = append ? [...prev.rows, ...(data.items || [])] : data.items || [];
        setHistory({ rows, items: target ? conversationMessages(rows) : rows, more: Boolean(data.hasMore), offset: data.nextOffset || 0, busy: false, error: '' });
      } catch (error) {
        if (current === generation.current) setHistory((h) => ({ ...h, busy: false, error: `历史目录暂时无法读取：${apiError(error)}` }));
      }
    },
    [api, currentConversation, history],
  );

  // 查询变化（继续输入）时退出子目录
  useEffect(() => {
    if (child) {
      setChild(null);
      setChecked(new Set());
    }
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => {
    void catalog.version;
    if (child) return childQuery ? searchReferences(childQuery, { items: history.items, limit: history.items.length }) : history.items;
    return searchReferences(query, { kind: historyMode ? '' : activeKind, currentConversation, items: historyMode ? history.items : null, limit: 40 });
  }, [catalog.version, child, childQuery, history.items, query, historyMode, activeKind, currentConversation]);

  const groups = useMemo(() => {
    const values: { key: string; name: string; turn?: any; rows: any[] }[] = [];
    let group: (typeof values)[number] | null = null;
    for (const item of results) {
      const name = item.group || KIND_LABELS[item.kind];
      const key = item.groupKey || name;
      if (group?.key !== key) {
        group = { key, name, turn: item.turnReference, rows: [] };
        values.push(group);
      }
      group!.rows.push(item);
    }
    return values;
  }, [results]);

  const withMode = (item: any) => normalizeReference({ ...item, ...(item.roleLabel ? { label: `${item.roleLabel} · ${item.label}` } : {}), mode });
  const applyPolicy = (items: any[]): Ref[] => applyConversationPolicy(items.map(withMode).filter(Boolean), selectedRefs, referencePolicyOptions()).filter(Boolean);
  const candidateWarning = (item: any) => (mode === 'content' ? policyReasonText(applyPolicy([item])[0]?.modeReason) : '');

  const choose = (item?: any) => {
    const items = child && checked.size ? history.items.filter((row) => checked.has(row.key)) : item ? [item] : [];
    const values = applyPolicy(items);
    if (values.length) {
      tap('select');
      onSelect(values);
    }
  };

  useImperativeHandle(ref, () => ({
    chooseHighlighted() {
      if (child && checked.size) {
        choose();
        return true;
      }
      if (!results.length) return false;
      choose(results[0]);
      return true;
    },
  }));

  const toggle = (item: any) => {
    const next = new Set(checked);
    if (next.has(item.key)) next.delete(item.key);
    else if (next.size >= 30) {
      setSelectionError('一次最多选择 30 条消息');
      return;
    } else next.add(item.key);
    setChecked(next);
    setSelectionError('');
  };

  const openChild = (item: any) => {
    tap('select');
    setChild(item);
    setChildQuery('');
    setChecked(new Set());
    setSelectionError('');
    const empty = { rows: [], items: [], more: false, offset: 0, busy: true, error: '' };
    setHistory(empty);
    void loadHistory(item, false, empty);
  };
  const back = () => {
    generation.current += 1;
    setChild(null);
    setChecked(new Set());
    setHistory({ rows: [], items: [], more: false, offset: 0, busy: false, error: '' });
  };
  const changeTab = (value: string) => {
    generation.current += 1;
    setFilter(value);
    setChild(null);
    setChecked(new Set());
    const empty = { rows: [], items: [], more: false, offset: 0, busy: false, error: '' };
    setHistory(empty);
    if (value === 'history') void loadHistory(null, false, empty);
  };

  const syncing = !catalog.connected || catalog.stale || !catalog.ready;
  const title = child?.label || (kind ? KIND_LABELS[kind] : '引用内容');
  const empty = history.error || (history.busy ? '正在读取历史…' : historyMode ? '没有匹配消息' : !catalog.ready ? (catalog.connected ? '正在同步目录…' : '引用目录尚未连接') : '没有匹配内容');

  return (
    <View style={[styles.panel, { backgroundColor: theme.dark ? theme.raised : theme.panel, borderColor: theme.border, maxHeight }]} testID="reference-panel">
      <View style={[styles.head, { borderBottomColor: theme.line }]}>
        {child ? (
          <Pressable onPress={back} hitSlop={8} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="返回会话候选" testID="ref-back">
            <Icon as={ChevronLeft} size={20} color={theme.subtle} />
          </Pressable>
        ) : null}
        <Text numberOfLines={1} style={[styles.title, { color: theme.textStrong }]}>
          {title}
        </Text>
        {syncing ? (
          <View style={styles.sync} accessibilityLabel={catalog.connected ? '目录同步中' : '正在连接'}>
            <View style={[styles.syncDot, { backgroundColor: theme.warning }]} />
            <Text style={[styles.small, { color: theme.warning }]}>{catalog.connected ? '同步中' : '未连接'}</Text>
          </View>
        ) : null}
        <View style={styles.modeSeg}>
          <Seg theme={theme} items={[{ key: 'content', label: '引用内容' }, { key: 'mention', label: '仅提及' }]} value={mode} onChange={(k) => setMode(k as 'content' | 'mention')} testID="ref-mode" />
        </View>
        <Pressable onPress={onClose} hitSlop={8} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="关闭引用选择器" testID="ref-close">
          <Icon as={X} size={18} color={theme.subtle} />
        </Pressable>
      </View>
      {!kind && !child ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.tabs} style={styles.tabsScroll}>
          {TABS.map(([value, label]) => {
            const on = filter === value;
            return (
              <Pressable key={value || 'all'} onPress={() => changeTab(value)} style={[styles.tab, on && { backgroundColor: theme.button }]} accessibilityRole="tab" accessibilityState={{ selected: on }} testID={`ref-tab-${value || 'all'}`}>
                <Text style={[styles.tabText, { color: on ? theme.buttonText : theme.subtle, fontWeight: on ? '600' : '400' }]}>{label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {child ? (
        <View style={[styles.childSearch, { backgroundColor: theme.hover }]}>
          <TextInput value={childQuery} onChangeText={setChildQuery} placeholder="搜索输入 / 输出…" placeholderTextColor={theme.muted} style={[styles.childInput, { color: theme.text }]} testID="ref-child-search" />
        </View>
      ) : null}
      <ScrollView keyboardShouldPersistTaps="always" style={styles.list} contentContainerStyle={styles.listContent} nestedScrollEnabled testID="ref-list">
        {groups.map((group, gi) => (
          <View key={`${group.key}:${gi}`}>
            <View style={styles.groupRow}>
              <Text numberOfLines={1} style={[styles.group, { color: theme.muted }]}>
                {group.name}
              </Text>
              {child && group.turn ? (
                <Pressable onPress={() => choose(group.turn)} style={[styles.range, { backgroundColor: theme.hover }]} accessibilityRole="button" testID="ref-turn">
                  <Text style={[styles.small, { color: theme.text }]}>{applyPolicy([group.turn])[0]?.mode === 'mention' ? '提及整轮' : '引用整轮'}</Text>
                </Pressable>
              ) : null}
            </View>
            {group.rows.map((item: any, index: number) => {
              const on = child && checked.has(item.key);
              const warning = candidateWarning(item);
              const first = gi === 0 && index === 0;
              return (
                <Press
                  key={item.key}
                  onPress={() => (child ? toggle(item) : choose(item))}
                  style={[styles.option, first && !child && { backgroundColor: theme.selected }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: Boolean(on) }}
                  testID={`ref-option-${item.kind}`}
                >
                  {child ? (
                    <View style={[styles.check, { borderColor: on ? theme.button : theme.border, backgroundColor: on ? theme.button : 'transparent' }]}>{on ? <Icon as={Check} size={12} color={theme.buttonText} strokeWidth={2.6} /> : null}</View>
                  ) : (
                    <Icon as={KIND_ICONS[item.kind] || BookText} size={17} color={theme.subtle} strokeWidth={1.8} />
                  )}
                  <View style={styles.copy}>
                    {child ? <Text style={[styles.small, { color: item.role === 'assistant' ? theme.blue : theme.muted }]}>{item.roleLabel}</Text> : null}
                    <Text numberOfLines={child ? 2 : 1} style={[styles.label, { color: theme.textStrong }]}>
                      {item.label}
                    </Text>
                    {warning ? (
                      <Text numberOfLines={1} style={[styles.small, { color: theme.warning }]}>⚠ {warning}</Text>
                    ) : !child ? (
                      <Text numberOfLines={1} style={[styles.small, { color: theme.muted }]}>
                        {referenceCandidateDetail(item)}
                      </Text>
                    ) : null}
                  </View>
                  {item.kind === 'chat' && !child ? (
                    <Pressable onPress={() => openChild(item)} hitSlop={6} style={[styles.range, { backgroundColor: theme.hover }]} accessibilityRole="button" accessibilityLabel={`选择 ${item.label} 中的消息`} testID="ref-messages">
                      <Text style={[styles.small, { color: theme.text }]}>消息 ›</Text>
                    </Pressable>
                  ) : null}
                </Press>
              );
            })}
          </View>
        ))}
        {!results.length ? (
          <View style={styles.empty}>
            {history.busy ? <ActivityIndicator size="small" color={theme.muted} /> : null}
            <Text style={[styles.small, { color: history.error ? theme.danger : theme.muted, textAlign: 'center' }]}>{empty}</Text>
          </View>
        ) : null}
        {historyMode && history.more ? (
          <Pressable onPress={() => void loadHistory(child, true)} disabled={history.busy} style={styles.more} testID="ref-more">
            <Text style={[styles.small, { color: theme.text }]}>{history.busy ? '加载中…' : '更多历史'}</Text>
          </Pressable>
        ) : history.error && historyMode && currentConversation ? (
          <Pressable onPress={() => void loadHistory(child, false)} style={styles.more}>
            <Text style={[styles.small, { color: theme.text }]}>重试</Text>
          </Pressable>
        ) : null}
      </ScrollView>
      <View style={[styles.foot, { borderTopColor: theme.line }]}>
        {child ? (
          <>
            <Text numberOfLines={1} style={[styles.small, { color: selectionError ? theme.danger : theme.muted, flex: 1 }]}>
              {selectionError || (checked.size ? `已选 ${checked.size} 条` : '点选消息，可多选（最多 30 条）')}
            </Text>
            <Pressable onPress={() => choose()} disabled={!checked.size} style={[styles.insert, { backgroundColor: theme.button, opacity: checked.size ? 1 : 0.4 }]} testID="ref-insert">
              <Text style={[styles.insertText, { color: theme.buttonText }]}>{mode === 'mention' ? '提及' : '引用'}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={[styles.small, { color: theme.muted, flex: 1 }]}>包含已归档</Text>
            <Switch
              value={catalog.includeArchived}
              onValueChange={(v) => setIncludeArchived(v)}
              trackColor={{ true: theme.button, false: theme.surfaceSoft }}
              thumbColor={theme.dark ? theme.subtle : theme.panel}
              accessibilityLabel="包含已归档"
              testID="ref-archived"
            />
          </>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  panel: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, marginBottom: 8, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 4, minHeight: 46, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 14, fontWeight: '600', minWidth: 0 },
  sync: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  syncDot: { width: 6, height: 6, borderRadius: 3 },
  modeSeg: { width: 150 },
  iconBtn: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  tabsScroll: { flexGrow: 0 },
  tabs: { gap: 6, paddingHorizontal: 10, paddingVertical: 8 },
  tab: { height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: 'center' },
  tabText: { fontSize: 13 },
  childSearch: { marginHorizontal: 10, marginTop: 8, borderRadius: 10, paddingHorizontal: 10 },
  childInput: { fontSize: 16, minHeight: 38, paddingVertical: 6 },
  list: { flexGrow: 0, flexShrink: 1 },
  listContent: { paddingBottom: 4 },
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 2 },
  group: { flex: 1, fontSize: 12 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingHorizontal: 12, paddingVertical: 6, marginHorizontal: 4, borderRadius: 10 },
  check: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, minWidth: 0, gap: 1 },
  label: { fontSize: 14.5 },
  small: { fontSize: 12, lineHeight: 16 },
  range: { paddingHorizontal: 9, height: 30, borderRadius: 8, justifyContent: 'center' },
  empty: { paddingVertical: 20, paddingHorizontal: 16, alignItems: 'center', gap: 8 },
  more: { alignItems: 'center', paddingVertical: 12 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, minHeight: 46, borderTopWidth: StyleSheet.hairlineWidth },
  insert: { height: 34, paddingHorizontal: 16, borderRadius: 17, justifyContent: 'center' },
  insertText: { fontSize: 14, fontWeight: '600' },
});

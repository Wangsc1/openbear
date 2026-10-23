/**
 * 上下文编辑器的“正文”层（B4-30～B4-37）：选中项的四种视图——
 *  - 结构化：系统提示词（CodeEditor markdown，失焦即应用）/ 工具定义表（筛选、添加、编辑、删除）/
 *            消息（元信息、关联调用跳转、助手内容块序列、用户/工具正文 CodeEditor markdown 或 json）；
 *  - 完整 JSON：CodeEditor json，“应用 JSON”，无效时报错；
 *  - 差异：改动列表（选择器）、原始与编辑后对照（只读 CodeEditor）、单项还原、全部还原；
 *  - 请求预览：服务端编译（不调用模型），校验错误/警告可定位编辑，载荷只读 CodeEditor。
 */
import { ArrowDown, ArrowUp, ArrowUpRight, Code, Diff, Eye, FileText, Pencil, Plus, RotateCcw, Trash, Wrench } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CodeEditor, Icon, OptionSheet, Press, SearchField, Segmented } from '../ui';
import type { Theme } from '../ui/theme';
import * as M from './model';
import { Banner, RoleTag, SectionHead, SmallButton } from './parts';

export type DocTab = 'structured' | 'raw' | 'diff' | 'preview';

type Props = {
  theme: Theme;
  uuid: string;
  state: M.EditorState;
  selected: M.Selected;
  tab: DocTab;
  setTab(tab: DocTab): void;
  choose(id: M.Selected): void;
  apply(fn: (s: M.EditorState) => M.EditorState): boolean;
  /** 失焦即应用的编辑器：记录最新值，切换/保存前 flush */
  setPendingText(p: { id: string; field: string; value: string } | null): void;
  flushText(): boolean;
  openEntity(draft: M.EntityDraft): void;
  askDialog(dialog: M.Dialog): void;
  pending: string;
  runPreview(): void;
  /** 平板并排时不显示顶部的标题行（目录已经标明） */
  compactHeader?: boolean;
};

export function DocumentPane(props: Props) {
  const { theme, state, selected, tab, setTab } = props;
  const doc = state.working;
  const changes = useMemo(() => M.diffDocument(state.baseline, doc), [state.baseline, doc]);
  const entry = M.findEntry(doc, selected);
  const tabs = [
    { key: 'structured', label: '结构化' },
    { key: 'raw', label: 'JSON' },
    { key: 'diff', label: changes.length ? `差异 ${changes.length}` : '差异' },
    { key: 'preview', label: '预览' },
  ];
  return (
    <View style={styles.root} testID="ce-document">
      <View style={styles.tabs}>
        <Segmented theme={theme} items={tabs} value={tab} onChange={(key) => props.flushText() && setTab(key as DocTab)} />
      </View>
      {tab === 'structured' ? (
        selected === 'system' ? (
          <SystemView {...props} />
        ) : selected === 'tools' ? (
          <ToolsView {...props} />
        ) : entry ? (
          <MessageView {...props} entry={entry} />
        ) : (
          <Text style={[styles.empty, { color: theme.muted }]}>消息已不存在</Text>
        )
      ) : tab === 'raw' ? (
        <RawView {...props} />
      ) : tab === 'diff' ? (
        <DiffView {...props} changes={changes} />
      ) : (
        <PreviewView {...props} />
      )}
    </View>
  );
}

function SystemView({ theme, uuid, state, setPendingText, flushText }: Props) {
  return (
    <View style={styles.fill}>
      <SectionHead theme={theme} title="系统正文" detail={`${state.working.system.length.toLocaleString()} 字符 · 离开编辑区自动应用到编辑稿 · 不写全局模板`} />
      <CodeEditor
        key={`${uuid}-system`}
        mode="markdown"
        language="markdown"
        value={state.working.system}
        onChange={(value) => setPendingText({ id: 'system', field: 'system', value })}
        onBlur={() => flushText()}
        style={styles.editorFill}
        testID="ce-system-editor"
      />
    </View>
  );
}

function ToolsView({ theme, state, openEntity, askDialog }: Props) {
  const [filter, setFilter] = useState('');
  const rows = M.toolRows(state.working, filter);
  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.toolbar}>
        <SearchField theme={theme} value={filter} onChange={setFilter} placeholder="筛选工具名称或说明" style={styles.flex} testID="ce-tool-filter" />
        <SmallButton theme={theme} icon={Plus} label="添加" onPress={() => openEntity(M.openEntity(state.working, 'tools', 'tool', -1))} testID="ce-tool-add" />
      </View>
      <View style={[styles.card, { borderColor: theme.line, backgroundColor: theme.panel }]}>
        {rows.map(({ tool, index }, i) => (
          <View key={`${index}-${tool.name}`} style={[styles.toolRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]}>
            <Press onPress={() => openEntity(M.openEntity(state.working, 'tools', 'tool', index))} style={styles.flex} accessibilityRole="button" accessibilityLabel={`编辑 ${tool.name}`} testID={`ce-tool-${index}`}>
              <Text numberOfLines={1} style={[styles.toolName, { color: theme.textStrong }]}>{tool.name || '未命名工具'}</Text>
              <Text numberOfLines={2} style={[styles.toolDesc, { color: theme.subtle }]}>{tool.description || '—'}</Text>
              <Text style={[styles.meta, { color: theme.muted }]}>{`${Object.keys(tool.parameters?.properties || {}).length} 个参数`}</Text>
            </Press>
            <Press
              onPress={() => askDialog({ kind: 'tool', index, impact: [`tools[${index}] ${tool.name}`] })}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel={`删除 ${tool.name}`}
              testID={`ce-tool-delete-${index}`}
            >
              <Icon as={Trash} size={17} color={theme.danger} />
            </Press>
          </View>
        ))}
        {!rows.length ? <Text style={[styles.empty, { color: theme.muted }]}>{filter ? '没有匹配的工具' : '还没有工具定义'}</Text> : null}
      </View>
      <Text style={[styles.help, { color: theme.muted }]}>这里只修改模型可见定义，不新增服务器执行权限。</Text>
    </ScrollView>
  );
}

const ROLE_OPTIONS = [
  { value: 'user', label: 'user' },
  { value: 'assistant', label: 'assistant' },
  { value: 'tool', label: 'tool' },
];

function MetaInput({ theme, label, value, onCommit, testID }: { theme: Theme; label: string; value: string; onCommit(v: string): void; testID?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <View style={styles.metaField}>
      <Text style={[styles.meta, { color: theme.subtle }]}>{label}</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        onEndEditing={() => text !== value && onCommit(text)}
        onSubmitEditing={() => text !== value && onCommit(text)}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bg }]}
        placeholderTextColor={theme.muted}
        testID={testID}
      />
    </View>
  );
}

function MessageView(props: Props & { entry: M.Entry }) {
  const { theme, uuid, state, entry, apply, choose, openEntity, askDialog, setPendingText, flushText } = props;
  const [rolePick, setRolePick] = useState(false);
  const message = entry.message;
  const doc = state.working;
  const index = doc.entries.findIndex((e) => e.entryId === entry.entryId);
  const pairs = useMemo(() => M.pairsFor(doc, entry.entryId), [doc, entry.entryId]);
  const sequence = useMemo(() => M.messageSequence(message), [message]);
  const extras = M.extraFields(message);
  const hints = useMemo(() => M.localIssues(doc).filter((i) => i.entryId === entry.entryId), [doc, entry.entryId]);
  const contentIsText = typeof message.content === 'string';
  const language = !contentIsText ? 'json' : message.role === 'tool' ? M.contentLanguage(message.content) : 'markdown';
  const setField = (key: string, value: any) => apply((s) => M.setField(s, entry.entryId, key, value));

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
      <View style={styles.entryActions}>
        <SmallButton theme={theme} icon={ArrowUp} label="上移" disabled={index <= 0} onPress={() => apply((s) => M.moveEntry(s, entry.entryId, -1))} testID="ce-move-up" />
        <SmallButton theme={theme} icon={ArrowDown} label="下移" disabled={index >= doc.entries.length - 1} onPress={() => apply((s) => M.moveEntry(s, entry.entryId, 1))} testID="ce-move-down" />
        <View style={styles.flex} />
        <SmallButton theme={theme} icon={Trash} label="删除" danger onPress={() => flushText() && askDialog({ kind: 'entries', ids: [entry.entryId], impact: M.entriesImpact(doc, [entry.entryId]) })} testID="ce-delete-entry" />
      </View>
      {hints.map((h, i) => (
        <Banner key={i} theme={theme} tone={h.severity === 'error' ? 'error' : 'warning'} text={h.text} />
      ))}

      <SectionHead theme={theme} title="消息元信息" />
      <View style={styles.metaGrid}>
        <View style={styles.metaField}>
          <Text style={[styles.meta, { color: theme.subtle }]}>角色</Text>
          <Press onPress={() => setRolePick(true)} style={[styles.input, styles.select, styles.roleSelect, { borderColor: theme.border, backgroundColor: theme.bg }]} accessibilityRole="button" accessibilityLabel="选择角色" testID="ce-role">
            <RoleTag theme={theme} role={String(message.role || '')} />
          </Press>
        </View>
        {message.role === 'tool' ? (
          <>
            <MetaInput theme={theme} label="工具名称" value={String(message.name || '')} onCommit={(v) => setField('name', v)} testID="ce-tool-name" />
            <MetaInput theme={theme} label="对应调用 ID" value={String(message.tool_call_id || '')} onCommit={(v) => setField('tool_call_id', v)} testID="ce-tool-call-id" />
          </>
        ) : null}
      </View>
      {message.role === 'tool' && pairs.length ? (
        <View style={styles.related}>
          <Text style={[styles.meta, { color: theme.subtle }]}>关联调用</Text>
          {pairs.map((p) => (
            <Press key={`${p.entryId}-${p.call.id}`} onPress={() => choose(p.entryId)} style={[styles.linkChip, { borderColor: theme.border }]} accessibilityRole="link" testID={`ce-related-${p.entryId}`}>
              <Text numberOfLines={1} style={[styles.linkText, { color: theme.text }]}>{`${p.call.name} · 第 ${doc.entries.findIndex((e) => e.entryId === p.entryId) + 1} 条`}</Text>
              <Icon as={ArrowUpRight} size={14} color={theme.subtle} />
            </Press>
          ))}
        </View>
      ) : null}

      {message.role === 'assistant' ? (
        <>
          <SectionHead
            theme={theme}
            title={sequence.ordered ? '内容块顺序' : '消息内容 · 顺序未记录'}
            detail={`${sequence.rows.length} 项`}
          />
          <View style={styles.entryActions}>
            <SmallButton
              theme={theme}
              icon={FileText}
              label="正文块"
              onPress={() => {
                let draft: M.EntityDraft | null = null;
                if (apply((s) => {
                  const r = M.revealBody(s, entry.entryId);
                  draft = r.draft;
                  return r.state;
                }) && draft) openEntity(draft);
              }}
              testID="ce-add-body"
            />
            <SmallButton theme={theme} icon={Wrench} label="工具调用" onPress={() => openEntity(M.openEntity(doc, entry.entryId, 'call', -1, '', `call_${M.localId()}`))} testID="ce-add-call" />
          </View>
          <Text style={[styles.help, { color: theme.muted }]}>{M.orderNote(state, message)}</Text>
          <View style={[styles.card, { borderColor: theme.line, backgroundColor: theme.panel }]}>
            {sequence.rows.map((block, i) => {
              const call = block.callId ? message.tool_calls?.find((c) => c.id === block.callId) : undefined;
              const results = block.callId ? pairs.filter((p) => p.call.id === block.callId).flatMap((p) => p.results) : [];
              return (
                <View key={block.key} style={[styles.block, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]} testID={`ce-block-${i}`}>
                  <View style={styles.blockHead}>
                    <Text style={[styles.blockNo, { color: theme.muted }]}>{sequence.ordered ? String(i + 1).padStart(2, '0') : '·'}</Text>
                    <Text numberOfLines={1} style={[styles.blockLabel, { color: block.thinking ? theme.violet : theme.textStrong }]}>{block.label}</Text>
                    <Text numberOfLines={1} style={[styles.meta, { color: theme.muted, flexShrink: 1 }]}>{`${block.source}${block.index != null ? `[${block.index}]` : ''}`}</Text>
                  </View>
                  <Text numberOfLines={6} style={[styles.preview, { color: theme.subtle }]}>{block.preview.slice(0, 420) || '（空内容）'}</Text>
                  {block.callId ? (
                    <View style={styles.related}>
                      <Text numberOfLines={1} style={[styles.mono, { color: theme.muted, flexShrink: 1 }]}>{block.callId}</Text>
                      {results.map((id) => (
                        <Press key={id} onPress={() => choose(id)} style={[styles.linkChip, { borderColor: theme.border }]} accessibilityRole="link" testID={`ce-result-${id}`}>
                          <Text style={[styles.linkText, { color: theme.text }]}>{`返回结果 · 第 ${doc.entries.findIndex((e) => e.entryId === id) + 1} 条`}</Text>
                          <Icon as={ArrowUpRight} size={14} color={theme.subtle} />
                        </Press>
                      ))}
                      {!results.length ? <Text style={[styles.meta, { color: theme.warning }]}>无关联结果</Text> : null}
                    </View>
                  ) : null}
                  <View style={styles.blockActions}>
                    <SmallButton theme={theme} icon={ArrowUp} label="上移" disabled={!M.canMoveBlock(message, block.key, -1)} onPress={() => apply((s) => M.shiftBlock(s, entry.entryId, block.key, -1))} testID={`ce-block-up-${i}`} />
                    <SmallButton theme={theme} icon={ArrowDown} label="下移" disabled={!M.canMoveBlock(message, block.key, 1)} onPress={() => apply((s) => M.shiftBlock(s, entry.entryId, block.key, 1))} testID={`ce-block-down-${i}`} />
                    <SmallButton theme={theme} icon={Pencil} label="编辑" onPress={() => openEntity(M.openBlock(doc, entry.entryId, block))} testID={`ce-block-edit-${i}`} />
                    {call ? (
                      <SmallButton
                        theme={theme}
                        icon={Trash}
                        label="删除…"
                        danger
                        onPress={() => {
                          try {
                            askDialog({ kind: 'call', id: entry.entryId, callId: call.id, impact: M.callImpact(doc, entry.entryId, call.id) });
                          } catch (e: any) {
                            apply(() => {
                              throw e;
                            });
                          }
                        }}
                        testID={`ce-block-delete-${i}`}
                      />
                    ) : null}
                  </View>
                </View>
              );
            })}
            {!sequence.rows.length ? <Text style={[styles.empty, { color: theme.muted }]}>此消息没有内容，可添加正文或调用。</Text> : null}
          </View>
          {extras.length ? (
            <>
              <SectionHead theme={theme} title={`附加字段与原生数据 · ${extras.length}`} detail="reasoning / signature 是附加字段，不代表独立的先后步骤；签名不会重新生成。" />
              <View style={[styles.card, { borderColor: theme.line, backgroundColor: theme.panel }]}>
                {extras.map((field, i) => (
                  <Press
                    key={field}
                    onPress={() => openEntity(M.openEntity(doc, entry.entryId, 'field', -1, field))}
                    style={[styles.fieldRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]}
                    pressedStyle={{ backgroundColor: theme.hover }}
                    accessibilityRole="button"
                    testID={`ce-extra-${field}`}
                  >
                    <Text style={[styles.mono, { color: theme.text, flex: 1 }]}>{field}</Text>
                    <Text style={[styles.meta, { color: theme.subtle }]}>查看 / 编辑</Text>
                  </Press>
                ))}
              </View>
              <View style={styles.entryActions}>
                <SmallButton
                  theme={theme}
                  icon={Trash}
                  label="联动删除思考…"
                  danger
                  onPress={() => {
                    const impact = M.reasoningImpact(doc, entry.entryId, true);
                    if (impact.length) askDialog({ kind: 'thinking', id: entry.entryId, impact });
                  }}
                  testID="ce-delete-thinking"
                />
              </View>
            </>
          ) : null}
        </>
      ) : message.content != null ? (
        <>
          <SectionHead
            theme={theme}
            title={message.role === 'tool' ? '工具结果' : '消息正文'}
            detail={contentIsText ? `${String(message.content).length.toLocaleString()} 字符 · 离开编辑区自动应用` : '内容块数组（只读预览），点“编辑内容块”修改'}
            right={contentIsText ? null : <SmallButton theme={theme} icon={Code} label="编辑内容块" onPress={() => openEntity(M.openEntity(doc, entry.entryId, 'field', -1, 'content'))} testID="ce-edit-blocks" />}
          />
          <CodeEditor
            key={`${uuid}-${entry.entryId}-content-${language}`}
            mode={language === 'json' ? 'code' : 'markdown'}
            language={language}
            readOnly={!contentIsText}
            value={M.display(message.content)}
            onChange={(value) => contentIsText && setPendingText({ id: entry.entryId, field: 'content', value })}
            onBlur={() => flushText()}
            style={styles.bodyEditor}
            testID="ce-body-editor"
          />
        </>
      ) : (
        <View style={styles.emptyBody}>
          <Text style={[styles.meta, { color: theme.muted }]}>此消息没有文本正文</Text>
          <SmallButton
            theme={theme}
            icon={Plus}
            label="添加正文"
            onPress={() => {
              let draft: M.EntityDraft | null = null;
              if (apply((s) => {
                const r = M.revealBody(s, entry.entryId);
                draft = r.draft;
                return r.state;
              }) && draft) openEntity(draft);
            }}
            testID="ce-reveal-body"
          />
        </View>
      )}
      <OptionSheet visible={rolePick} title="角色" options={ROLE_OPTIONS} value={String(message.role || '')} onClose={() => setRolePick(false)} onChange={(v: string) => v !== message.role && setField('role', v)} testID="ce-role-sheet" />
    </ScrollView>
  );
}

function RawView({ theme, uuid, state, selected, apply }: Props) {
  const source = M.rawText(state.working, selected);
  const [raw, setRaw] = useState(source);
  const [error, setError] = useState('');
  const sourceRef = useRef(source);
  useEffect(() => {
    if (sourceRef.current !== source) {
      sourceRef.current = source;
      setRaw(source);
      setError('');
    }
  }, [source]);
  const dirty = raw !== source;
  return (
    <View style={styles.fill}>
      <SectionHead
        theme={theme}
        title={M.selectionLabel(state.working, selected)}
        detail="保留全部字段 · 行号、括号配色与层级折叠"
        right={
          <SmallButton
            theme={theme}
            label="应用 JSON"
            primary
            disabled={!dirty}
            onPress={() => {
              try {
                const next = M.applyRaw(state, selected, raw);
                apply(() => next);
                setError('');
              } catch (e: any) {
                setError(String(e?.message || e));
              }
            }}
            testID="ce-raw-apply"
          />
        }
      />
      {error ? <Banner theme={theme} tone="error" text={`JSON 无效：${error}`} testID="ce-raw-error" /> : null}
      <CodeEditor key={`${uuid}-${selected}-raw`} mode="code" language="json" value={raw} onChange={setRaw} style={styles.editorFill} testID="ce-raw-editor" />
    </View>
  );
}

function DiffView({ theme, state, apply, changes }: Props & { changes: M.Change[] }) {
  const [diffId, setDiffId] = useState('');
  const [pick, setPick] = useState(false);
  const active = changes.find((c) => c.id === diffId) || changes[0];
  const kind = (c: M.Change) => (c.before === undefined ? '新增' : c.after === undefined ? '删除' : '修改');
  const label = (c: M.Change) => {
    if (c.id === 'system') return '系统提示词';
    if (c.id === 'tools') return '工具定义';
    if (c.id === 'order') return '消息顺序';
    const i = state.working.entries.findIndex((e) => e.entryId === c.id);
    return i >= 0 ? `第 ${i + 1} 条消息` : `已删除消息 ${c.id.slice(0, 8)}`;
  };
  return (
    <ScrollView contentContainerStyle={styles.scroll} nestedScrollEnabled>
      <SectionHead
        theme={theme}
        title={`${changes.length} 项改动`}
        detail="基线 → 编辑稿"
        right={<SmallButton theme={theme} icon={RotateCcw} label="全部还原" disabled={!changes.length} onPress={() => apply((s) => M.restore(s, null))} testID="ce-restore-all" />}
      />
      {!changes.length ? <Text style={[styles.empty, { color: theme.muted }]}>尚未修改上下文</Text> : null}
      {active ? (
        <>
          <View style={styles.toolbar}>
            <Press onPress={() => setPick(true)} style={[styles.input, styles.select, styles.flex, { borderColor: theme.border, backgroundColor: theme.bg }]} accessibilityRole="button" accessibilityLabel="选择差异项" testID="ce-diff-pick">
              <Text numberOfLines={1} style={{ color: theme.text, fontSize: 15 }}>{`${label(active)} · ${kind(active)}`}</Text>
            </Press>
            <SmallButton theme={theme} icon={RotateCcw} label="还原此项" onPress={() => apply((s) => M.restore(s, active))} testID="ce-restore-one" />
          </View>
          <Text style={[styles.diffLabel, { color: theme.subtle }]}>原始内容</Text>
          <CodeEditor key={`before-${active.id}-${state.epoch}`} mode="code" language={typeof active.before === 'string' ? 'plaintext' : 'json'} readOnly value={M.display(active.before)} style={styles.diffEditor} testID="ce-diff-before" />
          <Text style={[styles.diffLabel, { color: theme.subtle }]}>编辑后</Text>
          <CodeEditor key={`after-${active.id}-${state.epoch}`} mode="code" language={typeof active.after === 'string' ? 'plaintext' : 'json'} readOnly value={M.display(active.after)} style={styles.diffEditor} testID="ce-diff-after" />
          <OptionSheet
            visible={pick}
            title="选择差异项"
            options={changes.map((c) => ({ value: c.id, label: `${label(c)} · ${kind(c)}`, detail: c.id }))}
            value={active.id}
            onClose={() => setPick(false)}
            onChange={(v: string) => setDiffId(v)}
          />
        </>
      ) : null}
    </ScrollView>
  );
}

function PreviewView({ theme, state, pending, runPreview, choose, setTab }: Props) {
  const ready = M.previewReady(state);
  const serverIssues = M.serverIssues(state);
  const hints = M.localIssues(state.working);
  const payload = ready && state.preview.payload != null ? JSON.stringify(state.preview.payload, null, 2) : '';
  const blocking = serverIssues.some((i) => i.severity === 'error') || hints.some((i) => i.severity === 'error');
  const issues = [...serverIssues.map((i) => ({ ...i, origin: '服务端' })), ...hints.map((i) => ({ ...i, origin: '本地' }))];
  return (
    <ScrollView contentContainerStyle={styles.scroll} nestedScrollEnabled>
      <SectionHead
        theme={theme}
        title="实际请求"
        detail="只读，不发送模型"
        right={<SmallButton theme={theme} icon={Eye} label={pending === 'preview' ? '正在生成…' : '生成预览'} primary busy={pending === 'preview'} disabled={Boolean(pending)} onPress={runPreview} testID="ce-preview-run" />}
      />
      {issues.length ? (
        <View style={[styles.card, { borderColor: blocking ? theme.danger : theme.line, backgroundColor: theme.panel }]} testID="ce-issues">
          <Text style={[styles.issueHead, { color: blocking ? theme.danger : theme.subtle }]}>{`校验提示 · ${issues.length} 项${blocking ? ' · 存在阻止创建的错误' : ''}`}</Text>
          {issues.map((issue, i) => {
            const target = M.issueTarget(state.working, issue);
            return (
              <View key={i} style={[styles.issue, { borderTopColor: theme.line }]}>
                <Text style={[styles.issueText, { color: issue.severity === 'error' ? theme.danger : theme.warning }]}>{`${issue.origin} · ${issue.text}`}</Text>
                {issue.path ? <Text style={[styles.mono, { color: theme.muted }]}>{issue.path}</Text> : null}
                {target ? (
                  <Press
                    onPress={() => {
                      choose(target);
                      setTab('structured');
                    }}
                    hitSlop={8}
                    testID={`ce-issue-go-${i}`}
                  >
                    <Text style={[styles.link, { color: theme.textStrong }]}>定位编辑 →</Text>
                  </Press>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
      {payload ? (
        <CodeEditor key={`payload-${state.previewEpoch}`} mode="code" language="json" readOnly value={payload} style={styles.payloadEditor} testID="ce-preview-payload" />
      ) : (
        <View style={styles.emptyBody}>
          <Icon as={Diff} size={22} color={theme.disabled} />
          <Text style={[styles.issueHead, { color: theme.text }]}>{ready ? '未生成可用请求' : '尚未生成当前编辑稿的预览'}</Text>
          <Text style={[styles.meta, { color: theme.muted, textAlign: 'center' }]}>{ready ? '请根据校验提示定位并修正内容。' : '生成服务端实际请求后，可在这里检查 JSON；不会调用模型。'}</Text>
        </View>
      )}
      {ready ? <Text style={[styles.help, { color: theme.muted }]}>服务端校验不代表厂商验签通过；编译结果不会覆盖编辑稿。</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1, paddingBottom: 8 },
  flex: { flex: 1, minWidth: 0 },
  tabs: { paddingHorizontal: 12, paddingTop: 8 },
  scroll: { paddingBottom: 24 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  card: { marginHorizontal: 12, marginTop: 8, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 14, paddingRight: 4, paddingVertical: 10 },
  toolName: { fontSize: 15, fontWeight: '500' },
  toolDesc: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  meta: { fontSize: 12, lineHeight: 17 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  empty: { fontSize: 13.5, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 16 },
  help: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingTop: 8 },
  editorFill: { flex: 1, marginHorizontal: 12, minHeight: 240 },
  bodyEditor: { marginHorizontal: 12, height: 420 },
  diffEditor: { marginHorizontal: 12, height: 240 },
  payloadEditor: { marginHorizontal: 12, marginTop: 8, height: 520 },
  diffLabel: { fontSize: 12.5, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  entryActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  metaGrid: { paddingHorizontal: 12, gap: 8 },
  metaField: { gap: 4 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 },
  select: { justifyContent: 'center' },
  roleSelect: { alignItems: 'flex-start' },
  related: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 8 },
  linkChip: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 34, paddingHorizontal: 10, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth, maxWidth: '100%' },
  linkText: { fontSize: 13 },
  block: { paddingVertical: 10, paddingHorizontal: 2 },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10 },
  blockNo: { fontSize: 12, fontVariant: ['tabular-nums'], width: 20 },
  blockLabel: { fontSize: 14.5, fontWeight: '600', flexShrink: 1 },
  preview: { fontSize: 13, lineHeight: 18, paddingHorizontal: 38, paddingTop: 4 },
  blockActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 36, paddingTop: 8 },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 48 },
  emptyBody: { alignItems: 'center', gap: 8, paddingVertical: 28, paddingHorizontal: 16 },
  issueHead: { fontSize: 13.5, fontWeight: '600', paddingHorizontal: 12, paddingVertical: 10 },
  issue: { paddingHorizontal: 12, paddingVertical: 8, gap: 3, borderTopWidth: StyleSheet.hairlineWidth },
  issueText: { fontSize: 13, lineHeight: 18 },
  link: { fontSize: 13, fontWeight: '600', paddingTop: 2 },
});

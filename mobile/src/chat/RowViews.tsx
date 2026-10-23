/**
 * 消息行视图（每种行类型独立组件，供列表回收复用）。视觉按方向稿第 ②③④ 屏：
 * - 用户消息：右对齐中性浅底气泡；正文按引用胶囊切分（点胶囊看引用详情）；附件（图片缩略图 -> 全屏可左右切换、文件块）；
 *   下方一行操作：时间（长按看完整时间）、复制、引用本轮、从此处重来。事件来信/定时/推荐/实例消息改为左对齐信封卡片；
 * - 助手正文：无气泡、全宽；独占一段的产物链接换成原生产物卡片；图片可点开大图；“本轮执行失败”横幅；
 *   本轮最后一个正文块下方是回复尾部（复制 / 分享 / 隐藏 + 回复时间、耗时、Tokens）；
 * - 工作块：折叠一行“已工作 N 分 N 秒 · 读取 9 · 终端 6”；展开/运行中为时间线；合并的读取组可展开逐个看；
 * - 模型重试卡片、实时状态行（通知 / Agent 提醒 / 排队插话 / 正在思考）、上下文压缩行、Agent 卡片、交互记录卡片；
 * - 长按任意可隐藏行 -> 消息操作菜单（隐藏这条 / 隐藏本轮回复 / 选择多条）；选择模式下点按行切换勾选。
 */
import { Image } from 'expo-image';
import { AlertCircle, Bell, Check, CheckCircle2, ChevronRight, CircleX, Clock3, Copy, EyeOff, File as FileIcon, Layers, Link2, RefreshCw, RotateCcw, Share, Undo2 } from 'lucide-react-native';
import React, { memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ArtifactCard, ArtifactImagePath } from '../artifacts/ArtifactCard';
import { artifactFromUrl, artifactImagesIn, markdownImageUrls, splitArtifactPieces } from '../artifacts/artifactLinks';
import type { ChatRow, ToolRow } from '../data/rows';
import { retryStatusView, retryWaitLabel, modelRetryReasonLabel, reasoningPreviewText, fmtTokens, type Operation } from '../data/webLogic';
import { Icon, Press, tap } from '../ui/primitives';
import type { Theme } from '../ui/theme';
import { type as typeScale } from '../ui/theme';
import { clockTime, fullTime } from './chatApi';
import { CronCard, InstanceCard, WebhookCard } from './cards/MessageCards';
import { parseReferenceText, referenceScopeLabel, type Reference } from './cards/references';
import type { BodyRenderer } from './markdown/BodyRenderer';
import { absolutizeMarkdown, useChatRowContext } from './rowContext';
import { AgentCard, TimelineRail, TimelineStep, TimelineThought, withAlpha, type StepState } from './rowParts';
import { shortDuration, shortObjectName, shortTokens, toolCategory } from './timeline';
import { rowTargetId } from './visibility';

export type RowActions = {
  toggleWork(workKey: string): void;
  openDetail(opId: string, kind: 'tool' | 'reasoning' | 'agent' | 'interaction'): void;
  openFullText(messageId: string): void;
  /** 整条回复全文（回复尾部“复制”） */
  answerText?(messageId: string): string;
  /** 只读取本地 operation（交互问答卡片取标题/状态） */
  operation?(opId: string): Operation | undefined;
  // ---- b2 ----
  /** 本轮全部回复 Markdown（复制本轮 / 分享） */
  turnMarkdown?(turnKey: string): string;
  /** 长按消息 -> 消息操作菜单 */
  openMessageMenu?(row: ChatRow): void;
  /** 选择模式下点按行 */
  toggleSelect?(row: ChatRow): void;
  /** 用户消息：引用胶囊详情 */
  inspectReference?(ref: Reference, token: string, bundleId: string): void;
  /** 看大图（图片列表 + 起始下标） */
  openImages?(urls: string[], index: number): void;
  /** 打开产物预览 */
  openArtifact?(conversationUuid: string, artifactUuid: string, label: string): void;
  /** 引用本轮问答 / 从此处重来 */
  quoteTurn?(row: ChatRow): void;
  restartFrom?(row: ChatRow): void;
  copyUser?(row: ChatRow): void;
  shareReply?(turnKey: string): void;
  hideReply?(turnKey: string): void;
  /** 模型重试 */
  retryNow?(retry: any): void;
  cancelRetry?(retry: any): void;
  /** 合并读取组展开/收起 */
  toggleGroup?(key: string): void;
  /** 定位到某条历史消息（接续块跳回原提问） */
  locateOp?(opId: string): void;
};

type Props = { row: ChatRow; theme: Theme; renderer: BodyRenderer; actions: RowActions; padH: number };

function toolStepProps(row: ToolRow) {
  const category = toolCategory(row.title);
  const state: StepState = row.status === 'error' ? 'error' : row.status === 'running' ? 'running' : 'ok';
  if (row.group?.length) {
    const names = row.group.map((m) => shortObjectName(m.preview)).filter(Boolean);
    return { category: category.key, state, group: true, label: `读取 ${row.group.length} 个文件`, object: names.join('、'), duration: shortDuration(row.durationMs) };
  }
  return {
    category: category.key,
    state,
    group: false,
    // 已知类别显示类别名；其他工具（TaskMemory、上下文压缩…）显示自身名称，比“工具”更有信息量
    label: category.key === 'tool' ? row.title : category.label,
    object: shortObjectName(row.preview),
    duration: row.status === 'running' ? '…' : shortDuration(row.durationMs),
  };
}

/** 选择模式：行左侧的勾选框 + 点按切换；非选择模式时只是长按菜单入口。 */
function Selectable({ row, theme, actions, children, style }: { row: ChatRow; theme: Theme; actions: RowActions; children: React.ReactNode; style?: any }) {
  const state = (row as any).selectState as 'on' | 'off' | undefined;
  const target = rowTargetId(row);
  if (state) {
    return (
      <Pressable onPress={() => actions.toggleSelect?.(row)} style={[styles.selectRow, style]} accessibilityRole="checkbox" accessibilityState={{ checked: state === 'on' }} testID="row-selectable">
        {(row as any).selectHidden ? <View style={styles.checkSpace} /> : (
          <View style={[styles.check, state === 'on' ? { backgroundColor: theme.button, borderColor: theme.button } : { borderColor: theme.border }]}>
            {state === 'on' ? <Icon as={Check} size={13} color={theme.buttonText} strokeWidth={3} /> : null}
          </View>
        )}
        <View style={[styles.flex, state === 'on' && { opacity: 0.85 }]} pointerEvents="none">{children}</View>
      </Pressable>
    );
  }
  if (!target || !actions.openMessageMenu) return <View style={style}>{children}</View>;
  return (
    <Pressable onLongPress={() => { tap('medium'); actions.openMessageMenu?.(row); }} delayLongPress={420} style={style}>
      {children}
    </Pressable>
  );
}

// ---------------------------------------------------------------- 用户消息

function UserText({ row, theme, actions }: { row: Extract<ChatRow, { type: 'user' }>; theme: Theme; actions: RowActions }) {
  const parts = useMemo(() => parseReferenceText(row.text), [row.text]);
  const refs = row.references || [];
  let refIndex = 0;
  return (
    <Text selectable style={[styles.userText, { color: theme.text }]}>
      {parts.map((part, i) => {
        if (part.type === 'text') return <Text key={i}>{part.text}</Text>;
        const binding = refs[refIndex++];
        const bundleId = String(binding?.bundleId || row.referenceBundleId || '');
        const scope = referenceScopeLabel(part.ref);
        return (
          <Text
            key={i}
            onPress={() => { tap(); actions.inspectReference?.(part.ref, part.token, bundleId); }}
            style={[styles.refChip, { color: theme.blue, backgroundColor: theme.blueSoft }]}
            accessibilityRole="button"
            accessibilityLabel={`引用：${part.ref.label}`}
            testID="reference-chip"
          >
            {` @${part.ref.label}${scope ? ` · ${scope}` : ''} `}
          </Text>
        );
      })}
    </Text>
  );
}

function isImage(item: any) {
  return String(item?.kind || '').toLowerCase() === 'image' || String(item?.mimeType || '').startsWith('image/');
}

function Attachments({ items, theme, actions }: { items: any[]; theme: Theme; actions: RowActions }) {
  const ctx = useChatRowContext();
  const url = (item: any) => {
    const raw = String(item?.previewUrl || item?.contentUrl || item?.downloadUrl || '');
    return raw && raw.startsWith('/') ? `${ctx.baseUrl}${raw}` : raw;
  };
  const images = items.filter((item) => isImage(item) && url(item));
  const files = items.filter((item) => !(isImage(item) && url(item)));
  return (
    <View style={styles.attachments} testID="user-attachments">
      {images.length ? (
        <View style={styles.thumbs}>
          {images.map((item, i) => (
            <Press key={item.id || item.artifactUuid || i} onPress={() => actions.openImages?.(images.map(url), i)} style={[styles.thumb, { backgroundColor: theme.surfaceSoft, borderColor: theme.border }]} accessibilityRole="imagebutton" accessibilityLabel={item.fileName || item.name || '图片附件'} testID="user-attachment-image">
              <Image source={{ uri: url(item), headers: ctx.headers }} style={StyleSheet.absoluteFill} contentFit="cover" transition={100} />
            </Press>
          ))}
        </View>
      ) : null}
      {files.map((item, i) => {
        const identity = artifactFromUrl(String(item?.contentUrl || item?.previewUrl || item?.downloadUrl || ''));
        return (
          <Press
            key={item.id || item.artifactUuid || `f${i}`}
            onPress={() => (identity ? actions.openArtifact?.(identity.conversationUuid, identity.artifactUuid, item.fileName || item.name || '附件') : undefined)}
            style={[styles.fileTile, { backgroundColor: theme.panel, borderColor: theme.border }]}
            accessibilityRole="button"
            testID="user-attachment-file"
          >
            <Icon as={FileIcon} size={16} color={theme.subtle} />
            <Text numberOfLines={2} style={[styles.fileName, { color: theme.text }]}>{item.fileName || item.name || '附件'}</Text>
          </Press>
        );
      })}
    </View>
  );
}

/** 被唤醒继续的一轮：按实际时间出现在底部，可跳回原提问。 */
function ContinuationHeader({ row, theme, actions, padH }: { row: Extract<ChatRow, { type: 'user' }>; theme: Theme; actions: RowActions; padH: number }) {
  const info = row.continuation!;
  const started = Number(info.rootStartedAt || 0) * 1000;
  const label = !started ? '接续之前的一轮' : info.rootPreview ? `接续 ${clockTime(started).slice(0, 5)}「${info.rootPreview}」` : `接续 ${clockTime(started).slice(0, 5)} 的一轮`;
  const canLocate = Boolean(info.rootUserOpId && actions.locateOp);
  return (
    <View style={[styles.continuation, { paddingHorizontal: padH }]} testID="turn-continuation">
      <Text style={[styles.continuationText, { color: theme.muted }]}>后台任务完成后继续</Text>
      <Press onPress={() => { tap(); actions.locateOp?.(info.rootUserOpId); }} disabled={!canLocate} hitSlop={8} style={styles.flex}
             accessibilityRole="button" accessibilityLabel={`查看原提问：${info.rootPreview || ''}`} testID="turn-continuation-root">
        <Text numberOfLines={1} style={[styles.continuationText, { color: theme.muted }, canLocate && styles.continuationLink]}>{label}</Text>
      </Press>
    </View>
  );
}

function UserRowView({ row, theme, actions, padH }: { row: Extract<ChatRow, { type: 'user' }>; theme: Theme; actions: RowActions; padH: number }) {
  const ctx = useChatRowContext();
  const [copied, setCopied] = useState(false);
  const [showFull, setShowFull] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const source = row.source || 'user';
  const eventCard = ['webhook', 'cron', 'instance'].includes(source);
  const message = { ...row, content: row.text, createdAtMs: row.createdAtMs };
  if (eventCard) {
    return (
      <Selectable row={row} theme={theme} actions={actions} style={[styles.eventWrap, { paddingHorizontal: padH }]}>
        {source === 'webhook' ? <WebhookCard theme={theme} message={message} /> : source === 'cron' ? <CronCard theme={theme} message={message} /> : <InstanceCard theme={theme} message={message} />}
      </Selectable>
    );
  }
  const canTurn = Boolean(row.turnUuid && row.deleteTraceable && !String(row.opId || '').startsWith('local-'));
  const restartDisabled = ctx.running || Boolean(ctx.deletingTurn);
  const selecting = Boolean((row as any).selectState);
  return (
    <Selectable row={row} theme={theme} actions={actions} style={[styles.userWrap, { paddingHorizontal: padH }]}>
      <View style={styles.userCol}>
        {row.text ? (
          <View style={[styles.userBubble, { backgroundColor: theme.bubble }]} testID="row-user">
            <UserText row={row} theme={theme} actions={actions} />
          </View>
        ) : null}
        {row.attachments?.length ? <Attachments items={row.attachments} theme={theme} actions={actions} /> : null}
        {!selecting ? (
          <View style={styles.userMeta}>
            {row.createdAtMs ? (
              <Pressable onLongPress={() => setShowFull((v) => !v)} onPress={() => setShowFull((v) => !v)} hitSlop={6} accessibilityLabel={fullTime(row.createdAtMs)} testID="user-time">
                <Text style={[styles.metaText, { color: theme.muted }]}>{showFull ? fullTime(row.createdAtMs) : clockTime(row.createdAtMs)}</Text>
              </Pressable>
            ) : null}
            {row.text ? (
              <MetaBtn theme={theme} icon={copied ? Check : Copy} label={copied ? '已复制' : '复制消息'} onPress={() => { actions.copyUser?.(row); setCopied(true); }} testID="user-copy" />
            ) : null}
            {canTurn ? <MetaBtn theme={theme} icon={Link2} label="引用本轮问答" onPress={() => actions.quoteTurn?.(row)} testID="user-quote" /> : null}
            {canTurn ? (
              <MetaBtn theme={theme} icon={Undo2} label={ctx.running ? '请先停止当前运行' : '从此处重来'} disabled={restartDisabled} danger onPress={() => actions.restartFrom?.(row)} testID="user-restart" />
            ) : null}
            {ctx.deletingTurn && ctx.deletingTurn === row.turnUuid ? <ActivityIndicator size="small" color={theme.muted} /> : null}
          </View>
        ) : null}
      </View>
    </Selectable>
  );
}

function MetaBtn({ theme, icon, label, onPress, disabled, danger, testID }: { theme: Theme; icon: any; label: string; onPress(): void; disabled?: boolean; danger?: boolean; testID?: string }) {
  return (
    <Press onPress={() => { if (!disabled) { tap(); onPress(); } }} disabled={disabled} hitSlop={4} style={[styles.metaBtn, disabled && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} testID={testID}>
      <Icon as={icon} size={15} color={danger && !disabled ? theme.subtle : theme.muted} strokeWidth={1.9} />
    </Press>
  );
}

// ---------------------------------------------------------------- 回复

function AnswerBody({ row, theme, renderer, actions }: { row: Extract<ChatRow, { type: 'answer' }>; theme: Theme; renderer: BodyRenderer; actions: RowActions }) {
  const ctx = useChatRowContext();
  const Body = renderer.Component;
  const pieces = useMemo(() => splitArtifactPieces(row.markdown, ctx.baseUrl), [row.markdown, ctx.baseUrl]);
  const streaming = row.live && row.blockIndex === row.blockCount - 1;
  const onLink = (url: string) => {
    const id = artifactFromUrl(url, ctx.baseUrl);
    if (id && !id.download) actions.openArtifact?.(id.conversationUuid, id.artifactUuid, '');
    else if (id) actions.openArtifact?.(id.conversationUuid, id.artifactUuid, '');
    else void import('react-native').then(({ Linking }) => Linking.openURL(url));
  };
  const renderMd = (text: string, key: string | number) => {
    const md = absolutizeMarkdown(text, ctx.baseUrl);
    const images = markdownImageUrls(md);
    const artifactImages = artifactImagesIn(text, ctx.baseUrl);
    return (
      <View key={key}>
        <Body
          markdown={md}
          blockKind={row.blockKind}
          streaming={streaming}
          theme={theme}
          onLinkPress={onLink}
          onImagePress={images.length ? (url: string) => actions.openImages?.(images, Math.max(0, images.indexOf(url))) : undefined}
          imageRequestHeaders={images.length ? ctx.headers : undefined}
        />
        {artifactImages.map((id) => <ArtifactImagePath key={id.key} theme={theme} identity={id} />)}
      </View>
    );
  };
  if (pieces.length === 1 && pieces[0].kind === 'md') return renderMd(row.markdown, 0);
  return (
    <>
      {pieces.map((piece, i) => (piece.kind === 'md' ? renderMd(piece.text, i) : <ArtifactCard key={`${piece.identity.key}:${i}`} theme={theme} identity={piece.identity} label={piece.label} />))}
    </>
  );
}

function AnswerFooterRow({ row, theme, actions }: { row: Extract<ChatRow, { type: 'answer' }>; theme: Theme; actions: RowActions }) {
  const [copied, setCopied] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const f = row.footer!;
  const cache = Number(f.cacheTokens || 0);
  const pct = f.inputTokens ? `${Math.round((cache * 1000) / f.inputTokens) / 10}%` : '0%';
  const metaParts = [f.replyAtMs ? clockTime(f.replyAtMs) : '', shortDuration(f.durationMs), f.inputTokens || f.outputTokens ? `↑${shortTokens(f.inputTokens)} ↓${shortTokens(f.outputTokens)}` : ''].filter(Boolean);
  return (
    <View testID="answer-footer">
      <View style={styles.foot}>
        <FootBtn theme={theme} icon={copied ? Check : Copy} label={copied ? '已复制' : '复制本轮回复'} onPress={() => { actions.copyUser?.(row); setCopied(true); }} testID="answer-copy" />
        <FootBtn theme={theme} icon={Share} label="分享" onPress={() => actions.shareReply?.(row.turnKey)} testID="answer-share" />
        <FootBtn theme={theme} icon={EyeOff} label="隐藏回复" onPress={() => actions.hideReply?.(row.turnKey)} testID="answer-hide" />
        {metaParts.length ? (
          <Pressable onPress={() => setTokensOpen((v) => !v)} hitSlop={6} style={styles.footMetaWrap} accessibilityRole="button" accessibilityLabel="本轮用量" testID="answer-meta">
            <Text numberOfLines={1} style={[styles.footMeta, { color: theme.muted }]}>{metaParts.join(' · ')}</Text>
          </Pressable>
        ) : null}
      </View>
      {tokensOpen ? (
        <Text style={[styles.tokenDetail, { color: theme.muted }]} testID="answer-tokens">
          {[f.replyAtMs ? `回复 ${fullTime(f.replyAtMs)}` : '', f.durationMs ? `耗时 ${shortDuration(f.durationMs)}` : '', `输入 ${fmtTokens(f.inputTokens)}`, `输出 ${fmtTokens(f.outputTokens)}`, `缓存 ${fmtTokens(cache)}（${pct}）`].filter(Boolean).join('  ·  ')}
        </Text>
      ) : null}
    </View>
  );
}

function FootBtn({ theme, icon, label, onPress, testID }: { theme: Theme; icon: any; label: string; onPress(): void; testID?: string }) {
  return (
    <Press onPress={() => { tap(); onPress(); }} hitSlop={3} style={styles.footBtn} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <Icon as={icon} size={16} color={theme.muted} strokeWidth={1.9} />
    </Press>
  );
}

// ---------------------------------------------------------------- 重试 / 状态

function RetryRowView({ row, theme, actions }: { row: Extract<ChatRow, { type: 'retry' }>; theme: Theme; actions: RowActions }) {
  const ctx = useChatRowContext();
  const retry = row.retry || {};
  const status = retryStatusView(retry);
  const attempt = retry.attempt ? `第 ${retry.attempt}${retry.maxAttempts ? `/${retry.maxAttempts}` : ''} 次` : '';
  const detail = [modelRetryReasonLabel(retry), retryWaitLabel(retry)].filter(Boolean).join(' · ');
  const pending = ctx.retryPending?.waitId === retry.waitId ? ctx.retryPending : null;
  const tone = status.tone === 'success' ? theme.success : status.tone === 'failed' ? theme.danger : status.tone === 'waiting' ? theme.warning : theme.muted;
  const OutcomeIcon = status.tone === 'success' ? CheckCircle2 : status.tone === 'failed' ? CircleX : status.tone === 'waiting' ? Clock3 : AlertCircle;
  return (
    <View style={[styles.retry, { borderColor: retry.active ? withAlpha(theme.warning, 0.35) : theme.line, backgroundColor: retry.active ? theme.warningSoft : 'transparent' }]} testID="row-retry">
      <View style={styles.retryHead}>
        <Icon as={RefreshCw} size={14} color={theme.subtle} />
        <Text style={[styles.retryTitle, { color: theme.textStrong }]}>模型重试</Text>
        {attempt ? <Text style={[styles.metaText, { color: theme.subtle }]}>{attempt}</Text> : null}
        <View style={styles.flex} />
        <Icon as={OutcomeIcon} size={14} color={tone} />
        <Text style={[styles.metaText, { color: tone, fontWeight: '600' }]}>{status.label}</Text>
      </View>
      {detail ? <Text numberOfLines={3} style={[styles.retryDetail, { color: theme.subtle }]}>{detail}</Text> : null}
      {retry.active && retry.cancellable && retry.waitId ? (
        <View style={styles.retryActions}>
          <Press onPress={() => actions.retryNow?.(retry)} disabled={Boolean(pending)} style={[styles.retryBtn, { backgroundColor: theme.button, opacity: pending ? 0.5 : 1 }]} accessibilityRole="button" testID="retry-now">
            <Text style={[styles.retryBtnText, { color: theme.buttonText }]}>{pending?.action === 'now' ? '请求中…' : '立即重试'}</Text>
          </Press>
          <Press onPress={() => actions.cancelRetry?.(retry)} disabled={Boolean(pending)} style={[styles.retryBtn, { backgroundColor: theme.hover, opacity: pending ? 0.5 : 1 }]} accessibilityRole="button" testID="retry-cancel">
            <Text style={[styles.retryBtnText, { color: theme.text }]}>{pending?.action === 'cancel' ? '取消中…' : '取消重试'}</Text>
          </Press>
        </View>
      ) : null}
    </View>
  );
}

function Dots({ theme }: { theme: Theme }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v + 1) % 4), 380);
    return () => clearInterval(t);
  }, []);
  return <Text style={[styles.statusText, { color: theme.subtle, width: 18 }]}>{'.'.repeat(n)}</Text>;
}

function StatusRowView({ row, theme }: { row: Extract<ChatRow, { type: 'status' }>; theme: Theme }) {
  if (row.modelOutput) {
    const label = String(row.modelOutput?.toolNames?.join?.('、') || '');
    return (
      <View style={styles.statusRow} testID="row-status">
        <ActivityIndicator size="small" color={theme.blue} />
        <Text numberOfLines={2} style={[styles.statusText, { color: theme.subtle }]}>{row.modelOutput.phase === 'ready' ? '参数已接收，等待模型结束' : `正在生成工具参数${label ? ` · ${label}` : ''}`}</Text>
      </View>
    );
  }
  if (row.persistent) {
    return (
      <View style={styles.statusRow} testID="row-thinking">
        <Text style={[styles.statusText, { color: theme.subtle }]}>正在思考</Text>
        <Dots theme={theme} />
      </View>
    );
  }
  const icon = row.agentNotice ? Bell : row.notification ? CheckCircle2 : null;
  return (
    <View style={styles.statusRow} testID={row.queued || row.interruption ? 'row-steering' : 'row-status'}>
      {icon ? <Icon as={icon} size={14} color={row.agentNotice ? theme.violet : theme.success} /> : <View style={[styles.liveDot, { backgroundColor: row.active ? theme.blue : theme.muted }]} />}
      <View style={styles.flex}>
        <Text numberOfLines={2} style={[styles.statusText, { color: theme.text }]}>{row.text || '正在思考 ...'}</Text>
        {row.queued || row.interruption ? (
          <Text numberOfLines={2} style={[styles.statusPreview, { color: theme.muted }]}>{row.preview || (row.queued ? '等待当前运行处理' : '已交给主会话')}</Text>
        ) : !row.active && row.preview ? (
          <Text numberOfLines={2} style={[styles.statusPreview, { color: theme.muted }]}>{row.preview}</Text>
        ) : null}
      </View>
      {row.active && !row.queued && !row.interruption ? <Dots theme={theme} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------- 主体

function RowViewComponent({ row, theme, renderer, actions, padH }: Props) {
  const ctx = useChatRowContext();
  switch (row.type) {
    case 'user':
      if (row.synthetic) return row.continuation ? <ContinuationHeader row={row} theme={theme} actions={actions} padH={padH} /> : <View style={{ height: 8 }} />;
      return <UserRowView row={row} theme={theme} actions={actions} padH={padH} />;
    case 'answer': {
      const footer = row.footer;
      return (
        <Selectable row={row} theme={theme} actions={actions} style={{ paddingHorizontal: padH, paddingTop: row.blockIndex === 0 ? 4 : 0 }}>
          {row.failure && row.blockIndex === 0 ? (
            <View style={[styles.failBanner, { backgroundColor: theme.dangerSoft }]} testID="turn-failed">
              <Icon as={CircleX} size={15} color={theme.danger} />
              <Text style={[styles.failText, { color: theme.danger }]}>本轮执行失败</Text>
            </View>
          ) : null}
          <Pressable onLongPress={ctx.selecting ? undefined : () => { tap('medium'); actions.openMessageMenu ? actions.openMessageMenu(row) : actions.openFullText(row.messageId); }} delayLongPress={450} disabled={ctx.selecting} testID="row-answer">
            <AnswerBody row={row} theme={theme} renderer={renderer} actions={actions} />
          </Pressable>
          {footer && !ctx.selecting ? <AnswerFooterRow row={row} theme={theme} actions={actions} /> : null}
        </Selectable>
      );
    }
    case 'work_summary': {
      const counts = row.counts?.length ? row.counts.slice(0, 3).map((c) => `${c.label} ${c.count}`).join(' · ') : row.stepCount ? `${row.stepCount} 步` : '';
      return (
        <View style={[styles.workWrap, { paddingHorizontal: padH }]}>
          <Press
            onPress={() => {
              tap('select');
              actions.toggleWork(row.workKey);
            }}
            style={styles.workHead}
            pressedStyle={{ opacity: 0.55 }}
            accessibilityRole="button"
            accessibilityState={{ expanded: row.expanded }}
            accessibilityLabel={`${row.label}，${counts}`}
            testID="row-work-summary"
          >
            <View style={{ transform: [{ rotate: row.expanded ? '90deg' : '0deg' }] }}>
              <Icon as={ChevronRight} size={13} color={theme.muted} strokeWidth={2.2} />
            </View>
            <Text numberOfLines={1} style={[styles.workLabel, { color: theme.subtle }]}>
              {row.label}
            </Text>
            <Text numberOfLines={1} style={[styles.workCounts, { color: theme.muted }]}>
              {counts}
            </Text>
          </Press>
        </View>
      );
    }
    case 'tool': {
      if (row.compaction) {
        return (
          <Selectable row={row} theme={theme} actions={actions} style={{ paddingHorizontal: padH }}>
            <Press onPress={() => actions.openDetail(row.opId, 'tool')} style={styles.compaction} pressedStyle={{ backgroundColor: theme.hover }} accessibilityRole="button" testID="row-compaction">
              {row.inWork ? <TimelineRail theme={theme} node={row.status === 'error' ? 'error' : row.status === 'running' ? 'running' : 'ok'} /> : null}
              <Icon as={Layers} size={13} color={row.status === 'error' ? theme.danger : theme.success} strokeWidth={2} />
              <Text numberOfLines={1} style={[styles.compactionTitle, { color: row.status === 'error' ? theme.danger : theme.textStrong }]}>上下文压缩</Text>
              <Text numberOfLines={1} style={[styles.compactionPreview, { color: theme.subtle }]}>{row.preview}</Text>
              <Icon as={ChevronRight} size={13} color={theme.muted} />
            </Press>
          </Selectable>
        );
      }
      const p = toolStepProps(row);
      const groupKey = row.key;
      return (
        <Selectable row={row} theme={theme} actions={actions} style={{ paddingHorizontal: padH }}>
          <TimelineStep
            theme={theme}
            state={p.state}
            category={p.category}
            label={p.label}
            object={p.object}
            duration={p.duration}
            group={p.group}
            onPress={() => (row.group?.length ? actions.toggleGroup?.(groupKey) : actions.openDetail(row.opId, 'tool'))}
            testID={row.status === 'error' ? 'row-tool-error' : row.group?.length ? 'row-tool-group' : 'row-tool'}
          />
          {row.status === 'error' && !row.group ? <Text style={[styles.failTag, { color: theme.danger }]}>未成功</Text> : null}
        </Selectable>
      );
    }
    case 'reasoning': {
      const preview = reasoningPreviewText(row.preview);
      const text = row.active ? preview || '思考中…' : `思考${row.durationLabel ? ` · 持续了 ${row.durationLabel}` : ''}`;
      return (
        <Selectable row={row} theme={theme} actions={actions} style={{ paddingHorizontal: padH }}>
          <TimelineThought theme={theme} text={row.active ? text : `${text}${preview ? `\n${preview}` : ''}`} active={row.active} onPress={() => actions.openDetail(row.opId, 'reasoning')} testID="row-reasoning" />
        </Selectable>
      );
    }
    case 'agent':
      return (
        <Selectable row={row} theme={theme} actions={actions} style={[styles.cardWrap, { paddingHorizontal: padH }]}>
          <AgentCard
            theme={theme}
            title={row.taskTitle || row.title}
            statusKey={row.statusKey}
            statusLabel={row.statusLabel}
            toolName={row.toolName}
            startedAtMs={row.startedAtMs}
            durationMs={row.durationMs}
            current={row.current && row.current !== '任务完成' ? row.current : ''}
            onPress={() => actions.openDetail(row.opId, 'agent')}
            testID={`row-agent-${row.statusKey || 'unknown'}`}
          />
        </Selectable>
      );
    case 'interaction': {
      const v = row.view || {};
      const toneColor = v.statusTone === 'success' ? theme.success : v.statusTone === 'danger' ? theme.danger : v.statusTone === 'warning' || v.statusTone === 'waiting' ? theme.warning : v.statusTone === 'info' ? theme.blue : theme.subtle;
      return (
        <Selectable row={row} theme={theme} actions={actions} style={[styles.cardWrap, { paddingHorizontal: padH }]}>
          <Press onPress={() => actions.openDetail(row.opId, 'interaction')} style={[styles.record, { borderColor: theme.border, backgroundColor: theme.panel }]} accessibilityRole="button" testID="row-interaction">
            <View style={styles.flex}>
              <Text numberOfLines={1} style={[styles.recordLabel, { color: theme.muted }]}>{v.actionName || '交互'}{v.sourceLabel ? ` · ${v.sourceLabel}` : ''}</Text>
              <Text numberOfLines={2} style={[styles.recordTitle, { color: theme.textStrong }]}>{row.title}</Text>
              {v.intro ? <Text numberOfLines={1} style={[styles.recordIntro, { color: theme.subtle }]}>{v.intro}</Text> : null}
            </View>
            <Text style={[styles.recordStatus, { color: toneColor, backgroundColor: theme.hover }]}>{v.statusLabel || '已结束'}</Text>
            <Icon as={ChevronRight} size={15} color={theme.muted} />
          </Press>
        </Selectable>
      );
    }
    case 'retry':
      return (
        <Selectable row={row} theme={theme} actions={actions} style={{ paddingHorizontal: padH, paddingVertical: 4 }}>
          <RetryRowView row={row} theme={theme} actions={actions} />
        </Selectable>
      );
    case 'status':
      return (
        <View style={{ paddingHorizontal: padH }}>
          <StatusRowView row={row} theme={theme} />
        </View>
      );
    case 'marker': {
      const tone = row.tone === 'error' ? [theme.danger, theme.dangerSoft] : row.tone === 'warn' ? [theme.warning, theme.warningSoft] : [theme.subtle, theme.hover];
      return (
        <View style={[styles.marker, { paddingHorizontal: padH }]} testID="row-marker">
          <View style={[styles.markerPill, { backgroundColor: tone[1] }]}>
            <Text numberOfLines={1} style={[styles.markerText, { color: tone[0] }]}>
              {row.text}
            </Text>
          </View>
        </View>
      );
    }
    default:
      return null;
  }
}

export const RowView = memo(RowViewComponent, (a, b) => a.row === b.row && a.theme === b.theme && a.padH === b.padH && a.renderer === b.renderer && a.actions === b.actions);

export const RetryIcon = RotateCcw;

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  selectRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  checkSpace: { width: 22 },
  userWrap: { paddingTop: 14, paddingBottom: 6 },
  continuation: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 16, paddingBottom: 2 },
  continuationText: { fontSize: 13, lineHeight: 18 },
  continuationLink: { textDecorationLine: 'underline' },
  userCol: { alignItems: 'flex-end', alignSelf: 'stretch' },
  eventWrap: { paddingTop: 14, paddingBottom: 10 },
  userBubble: { maxWidth: '85%', borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10 },
  userText: { fontSize: typeScale.bubble, lineHeight: typeScale.bubbleLine },
  refChip: { fontSize: 14, fontWeight: '500' },
  attachments: { marginTop: 6, gap: 6, alignItems: 'flex-end', maxWidth: '85%' },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  thumb: { width: 96, height: 96, borderRadius: 14, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  fileTile: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, minHeight: 44, maxWidth: 260 },
  fileName: { fontSize: 13, flexShrink: 1 },
  userMeta: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 2, marginRight: -6 },
  metaText: { fontSize: 12, fontVariant: ['tabular-nums'], paddingHorizontal: 4 },
  metaBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  workWrap: { paddingTop: 2, paddingBottom: 4 },
  workHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40 },
  workLabel: { fontSize: 13.5, flexShrink: 0 },
  workCounts: { fontSize: 13, flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
  cardWrap: { paddingTop: 6, paddingBottom: 8 },
  marker: { alignItems: 'center', paddingVertical: 6 },
  markerPill: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3, maxWidth: '90%' },
  markerText: { fontSize: 12, lineHeight: 16 },
  failBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, marginBottom: 8 },
  failText: { fontSize: 13, fontWeight: '600' },
  failTag: { fontSize: 11.5, marginLeft: 22, marginTop: -6, marginBottom: 4 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: -9, marginBottom: 2 },
  footBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  footMetaWrap: { flex: 1, minHeight: 36, justifyContent: 'center', marginLeft: 6 },
  footMeta: { fontSize: 12, fontVariant: ['tabular-nums'] },
  tokenDetail: { fontSize: 12, lineHeight: 17, marginBottom: 8, fontVariant: ['tabular-nums'] },
  compaction: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 36, paddingLeft: 22, overflow: 'hidden' },
  compactionTitle: { fontSize: 13.5, fontWeight: '600', flexShrink: 0 },
  compactionPreview: { fontSize: 13, flex: 1, minWidth: 0 },
  retry: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 9, gap: 4 },
  retryHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  retryTitle: { fontSize: 13.5, fontWeight: '600' },
  retryDetail: { fontSize: 12.5, lineHeight: 18 },
  retryActions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  retryBtn: { minHeight: 36, borderRadius: 18, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  retryBtnText: { fontSize: 13, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34, paddingVertical: 4 },
  statusText: { fontSize: 13.5, lineHeight: 19 },
  statusPreview: { fontSize: 12.5, lineHeight: 18 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  record: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12 },
  recordLabel: { fontSize: 12 },
  recordTitle: { fontSize: 14.5, fontWeight: '600', lineHeight: 20 },
  recordIntro: { fontSize: 12.5, marginTop: 1 },
  recordStatus: { fontSize: 11.5, fontWeight: '600', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 7, overflow: 'hidden' },
});

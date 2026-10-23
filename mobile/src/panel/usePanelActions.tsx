/**
 * 会话面板的入口动作与它们打开的面板（手机“⋯”会话面板与平板右栏检查器共用）：
 *  - 会话属性 / 更新系统提示词：b1 的 ConversationPropertiesSheet / SystemPromptUpdateSheet；
 *  - 任务记忆：全屏页 /task-memory/[uuid]；
 *  - 编辑上下文：全屏页 /context-editor/[uuid]（运行中不可编辑）；
 *  - 产物：ArtifactsSheet。
 * 从一个 Sheet 里打开另一个 Sheet 时，先等前一个滑出（避免两个 Modal 叠在一起）。
 */
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { ConversationPropertiesSheet, SystemPromptUpdateSheet } from '../properties/ConversationPropertiesSheet';
import { showToast } from '../ui/Toast';
import { ArtifactsSheet } from './ArtifactsSheet';
import { isDraftConversation } from './hooks';

export type PanelSheet = 'properties' | 'systemPrompt' | 'artifacts' | null;

const SHEET_SWAP_MS = 280;

export function usePanelActions(uuid: string, { running }: { running: boolean }) {
  const [sheet, setSheet] = useState<PanelSheet>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => setSheet(null), [uuid]);
  const draft = isDraftConversation(uuid);

  /** delay：从另一个 Sheet 里触发时传 true */
  const later = useCallback((fn: () => void, delay?: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    if (delay) timer.current = setTimeout(fn, SHEET_SWAP_MS);
    else fn();
  }, []);

  const openSheet = useCallback((next: Exclude<PanelSheet, null>, delay?: boolean) => later(() => setSheet(next), delay), [later]);
  const openTaskMemory = useCallback(
    (delay?: boolean) => {
      if (draft) return;
      later(() => router.push({ pathname: '/task-memory/[uuid]', params: { uuid } }), delay);
    },
    [draft, later, uuid],
  );
  const openContextEditor = useCallback(
    (delay?: boolean) => {
      if (draft) return;
      if (running) {
        showToast('会话运行中无法编辑上下文');
        return;
      }
      later(() => router.push({ pathname: '/context-editor/[uuid]', params: { uuid } }), delay);
    },
    [draft, later, running, uuid],
  );

  const close = useCallback(() => setSheet(null), []);
  const panels = draft ? null : (
    <>
      <ConversationPropertiesSheet uuid={uuid} visible={sheet === 'properties'} onClose={close} />
      <SystemPromptUpdateSheet uuid={uuid} visible={sheet === 'systemPrompt'} onClose={close} />
      <ArtifactsSheet uuid={uuid} visible={sheet === 'artifacts'} onClose={close} />
    </>
  );
  return { draft, openSheet, openTaskMemory, openContextEditor, panels };
}

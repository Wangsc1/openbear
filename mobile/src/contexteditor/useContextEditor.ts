/**
 * 上下文编辑器控制器（React 状态 + 服务器请求 + 文件导入导出）：
 *  - 载入：GET /context-editor；与本机缓存（同一 App 进程内按会话保留的编辑稿）按 Web 的规则合并；
 *  - 改动：所有修改都走 model.ts 的纯函数（撤销栈、改动计数、预览失效）；
 *  - 预览：POST /context-editor/preview（服务端编译，不调用模型）；
 *  - 保存草稿：PUT /context-editor/draft（带 revision 乐观并发；409 时不覆盖）；
 *  - 创建分支：POST /context-editor/branch（前置条件同 Web），成功后返回新会话；
 *  - 导入：系统文件选择器选 JSON 完整包；导出：写入缓存目录后用系统分享。
 * “离开编辑区即应用”的编辑器（系统提示词、消息正文）在切换目录项/视图/保存前先 flush（pendingText）。
 */
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOpenBearApi } from '../panel/hooks';
import * as M from './model';

// 同一 App 进程内按会话保留编辑稿（Web 的 cache Map；离开页面再进来不丢本页编辑）
const cache = new Map<string, M.EditorState>();

export type Pending = '' | 'load' | 'preview' | 'save' | 'create';

export function useContextEditor(uuid: string, busy: boolean) {
  const api = useOpenBearApi();
  const [state, setStateRaw] = useState<M.EditorState | null>(() => cache.get(uuid) || null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<Pending>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0);
  const disposed = useRef(false);
  /** 尚未提交的文本编辑（编辑器失焦前的最新值） */
  const pendingText = useRef<{ id: string; field: string; value: string } | null>(null);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      generation.current += 1;
    };
  }, []);

  const setState = useCallback(
    (next: M.EditorState | null) => {
      stateRef.current = next;
      setStateRaw(next);
      if (next) cache.set(uuid, next);
    },
    [uuid],
  );

  /** 先应用待提交的文本，再执行修改。返回是否成功。 */
  const flushText = useCallback((): boolean => {
    const p = pendingText.current;
    if (!p || !stateRef.current) return true;
    pendingText.current = null;
    try {
      setState(M.commitText(stateRef.current, p.id, p.field, p.value));
      return true;
    } catch (e: any) {
      setError(String(e?.message || e));
      return false;
    }
  }, [setState]);

  const apply = useCallback(
    (fn: (s: M.EditorState) => M.EditorState): boolean => {
      if (pending === 'create') {
        setError('创建分支进行中，暂不能继续改动');
        return false;
      }
      if (!flushText()) return false;
      const s = stateRef.current;
      if (!s) return false;
      try {
        const next = fn(s);
        if (next !== s) setState(next);
        setError('');
        return true;
      } catch (e: any) {
        setError(String(e?.message || e));
        return false;
      }
    },
    [pending, flushText, setState],
  );

  const load = useCallback(async () => {
    if (!api) return;
    const stamp = ++generation.current;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const result: any = await api.contextEditor(uuid);
      if (disposed.current || stamp !== generation.current) return;
      setState(M.resolveLoaded(result, cache.get(uuid) || null));
    } catch (e: any) {
      if (stamp !== generation.current) return;
      setError(`${M.failure(e)}${stateRef.current ? '；未能核对最新上下文，当前仍保留原编辑稿。' : ''}`);
    } finally {
      if (stamp === generation.current) setLoading(false);
    }
  }, [api, uuid, setState]);

  useEffect(() => {
    void load();
  }, [load]);

  const preview = useCallback(async () => {
    if (!api || pending || !flushText()) return false;
    const s = stateRef.current;
    if (!s) return false;
    const stamp = generation.current;
    setPending('preview');
    setError('');
    try {
      const result: any = await api.previewContextEditor(uuid, M.requestData(s));
      if (disposed.current || stamp !== generation.current || stateRef.current?.epoch !== s.epoch) return false;
      if (!result?.ok) throw Error('服务器预览失败');
      setState({ ...stateRef.current!, preview: result, previewEpoch: s.epoch });
      return true;
    } catch (e) {
      if (stamp === generation.current) setError(M.failure(e));
      return false;
    } finally {
      if (stamp === generation.current) setPending('');
    }
  }, [api, uuid, pending, flushText, setState]);

  const saveDraft = useCallback(async () => {
    if (!api || pending || !flushText()) return;
    const s = stateRef.current;
    if (!s) return;
    const stamp = generation.current;
    setPending('save');
    setError('');
    try {
      const result: any = await api.saveContextEditorDraft(uuid, { ...M.requestData(s), snapshotToken: s.snapshotToken, revision: s.revision });
      if (disposed.current) return;
      if (!result?.ok || !result.draft) throw Error('服务器未返回草稿修订');
      if (stamp !== generation.current) return;
      const latest = stateRef.current!;
      setState({ ...latest, revision: result.draft.revision, savedEpoch: s.epoch });
      setNotice(latest.epoch === s.epoch ? '服务器草稿已保存' : '请求期间有新的编辑；新修改尚未保存');
    } catch (e) {
      if (stamp === generation.current) setError(M.failure(e));
    } finally {
      if (stamp === generation.current) setPending('');
    }
  }, [api, uuid, pending, flushText, setState]);

  const createBranch = useCallback(
    async (title: string): Promise<any | null> => {
      if (!api || pending || !flushText()) return null;
      const s = stateRef.current;
      if (!s) return null;
      const reason = M.branchBlockReason(s, { busy, title });
      if (reason) {
        setError(reason);
        return null;
      }
      const stamp = generation.current;
      setPending('create');
      setError('');
      try {
        const result: any = await api.createContextEditorBranch(uuid, { ...M.requestData(s), snapshotToken: s.snapshotToken, title: title.trim() });
        if (disposed.current || stamp !== generation.current) return null;
        if (!result?.ok || !result.conversation) throw Error('服务器未返回分支会话');
        return result.conversation;
      } catch (e) {
        if (stamp === generation.current) setError(M.failure(e));
        return null;
      } finally {
        if (stamp === generation.current) setPending('');
      }
    },
    [api, uuid, pending, busy, flushText],
  );

  const exportPackage = useCallback(async () => {
    if (!flushText()) return;
    const s = stateRef.current;
    if (!s) return;
    try {
      const pkg = M.exportPackage(s.baseline, s.working, s.mode, s.targetModel);
      const file = new File(Paths.cache, `openbear-context-edit-${uuid.slice(0, 8)}.json`);
      if (file.exists) file.delete();
      file.create();
      file.write(JSON.stringify(pkg, null, 2));
      if (!(await Sharing.isAvailableAsync())) throw Error('当前设备不支持系统分享');
      await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: '导出完整上下文包', UTI: 'public.json' });
    } catch (e: any) {
      setError(`导出失败：${String(e?.message || e)}`);
    }
  }, [uuid, flushText]);

  const importPackage = useCallback(async () => {
    if (pending === 'create' || !flushText()) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], copyToCacheDirectory: true, multiple: false });
      if (picked.canceled || !picked.assets?.[0]) return;
      const text = await new File(picked.assets[0].uri).text();
      const s = stateRef.current;
      if (!s) throw Error('请先载入会话快照');
      setState(M.importIntoState(s, JSON.parse(text)));
      setError('');
      setNotice('完整基线和编辑稿已导入；源快照仍由服务器检查');
      return true;
    } catch (e: any) {
      setError(`导入失败：${String(e?.message || e)}`);
      return false;
    }
  }, [pending, flushText, setState]);

  return {
    state,
    loading,
    pending,
    error,
    notice,
    setError,
    setNotice,
    load,
    apply,
    flushText,
    pendingText,
    preview,
    saveDraft,
    createBranch,
    exportPackage,
    importPackage,
  };
}

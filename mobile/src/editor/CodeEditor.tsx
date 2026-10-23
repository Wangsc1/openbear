/**
 * 内嵌代码编辑器（WebView + Monaco，离线 HTML 见 editorHtml.generated.ts / mobile/editor/）。
 * 对应 Web 的两个编辑器：
 *   mode='markdown'：MdEditor（记忆、文档、提示词模板、Cron/触发器说明等），补全模式 memory/template/none；
 *   mode='code'：上下文编辑器的 CodeEditor（JSON 等，行号、折叠、格式化）。
 * 语法高亮、补全规则、配色与 Web 一致（同一份 Monaco、同一份补全代码、同一套主题颜色）。
 *
 * 受控用法：value + onChange（每次修改都回调）；onBlur 时给出最终值，适合“失焦提交”。
 * 通过 ref 可以 format()（JSON 格式化）、focus()、blur()、insert(text)。
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { useTheme } from '../ui/theme';
import { EDITOR_HTML } from './editorHtml.generated';

export type CompletionMode = 'memory' | 'template' | 'none';
export type RefData = { mem: { key: string; name?: string; note?: string }[]; secret: { key: string; note?: string }[]; doc: { key: string; title?: string }[] };

export type CodeEditorHandle = {
  format(): void;
  focus(): void;
  blur(): void;
  insert(text: string): void;
};

type Props = {
  value: string;
  onChange?: (value: string) => void;
  onBlur?: (value: string) => void;
  onFocus?: () => void;
  onFormatError?: (message: string) => void;
  mode?: 'markdown' | 'code';
  /** Monaco 语言：markdown / json / python / javascript / shell / yaml / plaintext */
  language?: string;
  readOnly?: boolean;
  completionMode?: CompletionMode;
  /** 模板补全可用的变量根（与 Web 的 completionRoots 相同，null 表示全部） */
  completionRoots?: string[] | null;
  refData?: RefData;
  fontSize?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const EMPTY_REFS: RefData = { mem: [], secret: [], doc: [] };

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { value, onChange, onBlur, onFocus, onFormatError, mode = 'markdown', language, readOnly = false, completionMode = 'none', completionRoots = null, refData = EMPTY_REFS, fontSize = 16, style, testID },
  ref,
) {
  const theme = useTheme();
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const nativeFocused = useRef(false);
  // 编辑器里最新的值；外部 value 与它相同时不回写，避免打字时光标跳动
  const current = useRef(value);
  // 编辑器发出过的最近几个值：快速输入时 onChange 异步回到 value，会比编辑器里的内容旧，这些不是外部修改，不能回写
  const emitted = useRef<string[]>([]);
  const callbacks = useRef({ onChange, onBlur, onFocus, onFormatError });
  callbacks.current = { onChange, onBlur, onFocus, onFormatError };

  const send = useCallback((message: Record<string, unknown>) => {
    const script = `window.openbearEditor && window.openbearEditor.receive(${JSON.stringify(message)}); true;`;
    web.current?.injectJavaScript(script);
  }, []);

  const init = useRef({ value, mode, language, readOnly, completionMode, completionRoots, refData, fontSize, dark: theme.dark });
  init.current = { value: current.current, mode, language, readOnly, completionMode, completionRoots, refData, fontSize, dark: theme.dark };

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: any;
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      switch (message?.type) {
        case 'loaded':
          send({ type: 'init', ...init.current });
          break;
        case 'ready':
          setReady(true);
          break;
        case 'change':
          current.current = String(message.value ?? '');
          emitted.current = [...emitted.current.slice(-19), current.current];
          callbacks.current.onChange?.(current.current);
          break;
        case 'blur':
          nativeFocused.current = false;
          current.current = String(message.value ?? current.current);
          callbacks.current.onBlur?.(current.current);
          break;
        case 'focus':
          // Android：WebView 没有原生焦点时，编辑器输入框聚焦也不会弹出输入法（IMM 忽略 showSoftInput）。
          // 先把原生焦点给 WebView，再让编辑器重新聚焦一次触发输入法。
          if (Platform.OS === 'android' && !nativeFocused.current) {
            nativeFocused.current = true;
            web.current?.requestFocus();
            send({ type: 'refocus' });
          }
          callbacks.current.onFocus?.();
          break;
        case 'formatError':
          callbacks.current.onFormatError?.(String(message.message || ''));
          break;
        default:
          break;
      }
    },
    [send],
  );

  useEffect(() => {
    if (!ready || value === current.current || emitted.current.includes(value)) return;
    current.current = value;
    emitted.current = [];
    send({ type: 'setValue', value });
  }, [ready, value, send]);

  useEffect(() => {
    if (ready) send({ type: 'setTheme', dark: theme.dark });
  }, [ready, theme.dark, send]);

  useEffect(() => {
    if (ready) send({ type: 'setOptions', readOnly, fontSize, completionMode, completionRoots, refData });
  }, [ready, readOnly, fontSize, completionMode, completionRoots, refData, send]);

  useImperativeHandle(
    ref,
    () => ({
      format: () => send({ type: 'format' }),
      focus: () => {
        nativeFocused.current = true;
        web.current?.requestFocus();
        send({ type: 'focus' });
      },
      blur: () => send({ type: 'blur' }),
      insert: (text: string) => send({ type: 'insert', text }),
    }),
    [send],
  );

  const source = useMemo(() => ({ html: EDITOR_HTML, baseUrl: 'https://editor.openbear.local/' }), []);

  return (
    <View style={[styles.root, { borderColor: theme.border, backgroundColor: theme.panel }, style]} testID={testID}>
      <WebView
        ref={web}
        source={source}
        originWhitelist={['*']}
        onMessage={onMessage}
        javaScriptEnabled
        // 编辑器完全离线：不加载任何外部资源，也不允许跳转
        onShouldStartLoadWithRequest={(request) => request.url.startsWith('https://editor.openbear.local') || request.url === 'about:blank'}
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        hideKeyboardAccessoryView
        keyboardDisplayRequiresUserAction={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        textZoom={100}
        webviewDebuggingEnabled={__DEV__}
        style={[styles.web, { backgroundColor: 'transparent', opacity: ready ? 1 : 0 }]}
        containerStyle={{ backgroundColor: 'transparent' }}
        androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
      />
      {!ready ? (
        <View style={[StyleSheet.absoluteFill, styles.loading]}>
          <ActivityIndicator color={theme.muted} />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden', minHeight: 160 },
  web: { flex: 1 },
  loading: { alignItems: 'center', justifyContent: 'center' },
});

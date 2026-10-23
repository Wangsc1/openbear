/**
 * 添加服务器 / 登录（多服务器的入口）。
 *
 * 两步：
 *   1. 地址：输入 OpenBear 地址（自己部署的主控、子实例或访问网关），App 探测服务器类型和登录方式；
 *   2. 登录：主控 = Secret Key + Telegram 审批（显示等待状态，可取消）；子实例/网关 = 用户名密码。
 * 同一组件也用于已保存服务器的重新登录（reloginId），此时跳过第 1 步。
 */
import { ChevronLeft, Globe, KeyRound, Server, ShieldCheck } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '../../data/session';
import {
  type ApprovalHandle,
  type LoginStatus,
  type ServerProbe,
  loginErrorText,
  passwordLogin,
  probeServer,
  startApprovalLogin,
} from '../../transport/auth';
import { Icon, IconButton, Press, tap } from '../primitives';
import { radius, type as typeScale, useTheme } from '../theme';

type Props = {
  /** 已保存服务器重新登录 */
  reloginId?: string;
  /** 放在模态页里时显示返回按钮 */
  onClose?: () => void;
  /** 登录成功（未提供时用 onClose） */
  onDone?: () => void;
};

const KIND_LABEL: Record<string, string> = { controller: 'OpenBear 主控', managed: 'OpenBear 实例', gateway: '访问网关' };

export function ServerConnect({ reloginId, onClose, onDone }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const relogin = reloginId ? session.servers.find((s) => s.id === reloginId) : undefined;
  const [url, setUrl] = useState(relogin?.baseUrl || session.devServerUrl || '');
  const [name, setName] = useState(relogin?.name || '');
  const [probe, setProbe] = useState<ServerProbe | null>(
    relogin
      ? { baseUrl: relogin.baseUrl, kind: relogin.kind, login: relogin.login, version: relogin.version, appAuth: true, instancesFeature: relogin.instancesFeature }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');
  const [username, setUsername] = useState(relogin?.username || '');
  const [password, setPassword] = useState('');
  const [approval, setApproval] = useState<LoginStatus | ''>('');
  const handle = useRef<ApprovalHandle | null>(null);
  // 限流（429）后按服务端 retryAfter 冷却，冷却中不允许再提交
  const [coolUntil, setCoolUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const cooling = coolUntil > now;

  useEffect(() => () => handle.current?.cancel(), []);
  useEffect(() => {
    if (!coolUntil) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= coolUntil) setCoolUntil(0);
    }, 1000);
    return () => clearInterval(timer);
  }, [coolUntil]);

  const fail = (err: any) => {
    if (err?.status === 429) {
      const seconds = Number(err?.body?.retryAfter) || 60;
      setCoolUntil(Date.now() + seconds * 1000);
      setNow(Date.now());
    }
    setError(loginErrorText(err));
  };

  const detect = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await probeServer(url);
      if (!result.appAuth) throw Object.assign(new Error(), { body: { error: 'app_token_missing' } });
      if (result.login === 'none') throw Object.assign(new Error(), { body: { error: 'local_auth_disabled' } });
      setProbe(result);
      tap('light');
    } catch (err) {
      setError(loginErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (appSession: Awaited<ReturnType<typeof passwordLogin>>, user?: string) => {
    if (!probe) return;
    if (relogin) await session.completeLogin(relogin.id, appSession, user);
    else await session.addServer(probe, appSession, name, user);
    tap('medium');
    (onDone || onClose)?.();
  };

  const submitPassword = async () => {
    if (!probe) return;
    setBusy(true);
    setError('');
    try {
      await finish(await passwordLogin(probe.baseUrl, username.trim(), password), username.trim());
    } catch (err) {
      fail(err);
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  const submitSecret = async () => {
    if (!probe) return;
    setBusy(true);
    setError('');
    try {
      const started = await startApprovalLogin(probe.baseUrl, secret.trim(), setApproval);
      handle.current = started;
      const appSession = await started.done;
      await finish(appSession);
    } catch (err: any) {
      if (err?.body?.error !== 'aborted') fail(err);
      setApproval('');
    } finally {
      handle.current = null;
      setBusy(false);
    }
  };

  const cancelApproval = () => {
    handle.current?.cancel();
    setApproval('');
    setBusy(false);
  };

  const field = (props: React.ComponentProps<typeof TextInput> & { label: string }) => {
    const { label, ...rest } = props;
    return (
      <View style={styles.field}>
        <Text style={[styles.label, { color: theme.subtle }]}>{label}</Text>
        <TextInput
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoCorrect={false}
          {...rest}
          style={[styles.input, { color: theme.text, backgroundColor: theme.panel, borderColor: theme.border }]}
        />
      </View>
    );
  };

  const primary = (label: string, onPress: () => void, disabled: boolean, testID: string) => (
    <Press
      testID={testID}
      onPress={onPress}
      disabled={disabled || busy || cooling}
      style={[styles.button, { backgroundColor: theme.button, opacity: disabled || busy || cooling ? 0.5 : 1 }]}
    >
      {busy && !approval ? (
        <ActivityIndicator color={theme.buttonText} />
      ) : (
        <Text style={[styles.buttonText, { color: theme.buttonText }]}>{cooling ? `${Math.ceil((coolUntil - now) / 1000)} 秒后可重试` : label}</Text>
      )}
    </Press>
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingTop: insets.top + (onClose ? 8 : 56), paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        testID="server-connect"
      >
        {onClose || (probe && !relogin) ? (
          <View style={styles.topBar}>
            <IconButton
              icon={ChevronLeft}
              theme={theme}
              label="返回"
              testID="server-connect-back"
              onPress={() => {
                if (probe && !relogin && !approval) {
                  setProbe(null);
                  setError('');
                } else onClose?.();
              }}
            />
          </View>
        ) : null}
        <View style={[styles.mark, { backgroundColor: theme.surfaceSoft }]}>
          <Icon as={probe ? (probe.login === 'telegram_approval' ? KeyRound : ShieldCheck) : Server} size={26} color={theme.textStrong} />
        </View>
        <Text style={[styles.title, { color: theme.textStrong }]}>{relogin ? `登录 ${relogin.name}` : probe ? '登录' : '连接 OpenBear'}</Text>
        <Text style={[styles.hint, { color: theme.subtle }]}>
          {probe
            ? `${KIND_LABEL[probe.kind] || 'OpenBear'}${probe.version ? ` · ${probe.version}` : ''}\n${probe.baseUrl}`
            : '输入你自己部署的 OpenBear 地址，可以是主控、实例或访问网关。之后可以在设置里添加更多服务器。'}
        </Text>

        {!probe ? (
          <>
            {field({ label: '服务器地址', value: url, onChangeText: setUrl, placeholder: 'https://bear.example.com', keyboardType: 'url', testID: 'server-url', returnKeyType: 'go', onSubmitEditing: detect })}
            {field({ label: '名称（可选）', value: name, onChangeText: setName, placeholder: '例如：家里的主控', testID: 'server-name' })}
            {primary('下一步', detect, !url.trim(), 'server-detect')}
          </>
        ) : probe.login === 'telegram_approval' ? (
          approval ? (
            <View style={[styles.waiting, { backgroundColor: theme.panel, borderColor: theme.border }]} testID="approval-waiting">
              <ActivityIndicator color={theme.blue} />
              <Text style={[styles.waitTitle, { color: theme.textStrong }]}>等待 Telegram 确认</Text>
              <Text style={[styles.hint, { color: theme.subtle, textAlign: 'center' }]}>已向管理员的 Telegram 发送登录确认，点“确认登录”后这里会自动继续。</Text>
              <Press onPress={cancelApproval} style={[styles.secondary, { borderColor: theme.border }]} testID="approval-cancel">
                <Text style={{ color: theme.text, fontSize: typeScale.body }}>取消</Text>
              </Press>
            </View>
          ) : (
            <>
              {field({ label: 'Secret Key', value: secret, onChangeText: setSecret, placeholder: '控制台的 Web Secret Key', secureTextEntry: true, testID: 'login-secret', returnKeyType: 'go', onSubmitEditing: submitSecret })}
              <Text style={[styles.note, { color: theme.muted }]}>提交后需要在 Telegram 里确认这次登录。</Text>
              {primary('登录', submitSecret, !secret.trim(), 'login-submit')}
            </>
          )
        ) : (
          <>
            {field({ label: '用户名', value: username, onChangeText: setUsername, placeholder: '用户名', textContentType: 'username', testID: 'login-username' })}
            {field({ label: '密码', value: password, onChangeText: setPassword, placeholder: '密码', secureTextEntry: true, textContentType: 'password', testID: 'login-password', returnKeyType: 'go', onSubmitEditing: submitPassword })}
            {primary('登录', submitPassword, !username.trim() || !password, 'login-submit')}
          </>
        )}

        {error ? (
          <Text style={[styles.error, { color: theme.danger }]} testID="server-connect-error">
            {error}
          </Text>
        ) : null}
        {!probe && session.servers.length ? (
          <View style={[styles.footer, { borderTopColor: theme.line }]}>
            <Icon as={Globe} size={15} color={theme.muted} />
            <Text style={[styles.note, { color: theme.muted }]}>已添加 {session.servers.length} 个服务器，可在“设置 · 服务器”里切换。</Text>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 24, gap: 14, maxWidth: 520, width: '100%', alignSelf: 'center' },
  topBar: { flexDirection: 'row', marginLeft: -12, marginBottom: 4 },
  mark: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  title: { fontSize: 26, fontWeight: '700', marginTop: 4 },
  hint: { fontSize: typeScale.small, lineHeight: typeScale.smallLine },
  field: { gap: 6 },
  label: { fontSize: 12.5, fontWeight: '500' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 13 : 10, fontSize: 16 },
  button: { borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', height: 48, marginTop: 4, overflow: 'hidden' },
  buttonText: { fontSize: 16, fontWeight: '600' },
  secondary: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, height: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  waiting: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: 20, alignItems: 'center', gap: 10, marginTop: 8 },
  waitTitle: { fontSize: 16, fontWeight: '600' },
  note: { fontSize: 12.5, lineHeight: 18, flexShrink: 1 },
  error: { fontSize: typeScale.small, lineHeight: typeScale.smallLine },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14, marginTop: 12 },
});

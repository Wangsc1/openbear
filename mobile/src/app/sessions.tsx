/**
 * 登录设备（对应 Web 的 SessionsView + ManagedAccountForm）：当前服务器上的有效登录。
 * - 列表：设备与客户端（含 App 自己）、IP、最近活动、登录时间、有效期；当前设备排第一；
 * - 撤销其他设备；“退出本机”等同退出当前服务器的登录；
 * - 子实例本地账号 / 访问网关账号：修改账号与密码，成功后所有设备退出。
 * 主控 controller：DELETE /api/auth/sessions/{id}；网关退出本机用 POST /api/auth/logout（由 session.signOut 处理）。
 */
import { router } from 'expo-router';
import { ChevronLeft, Globe, KeyRound, Monitor, RefreshCw, Smartphone } from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { describeSessionUserAgent, formatSessionTime, passwordHint, relativeSessionTime } from '../data/sessionPresentation';
import { useSession } from '../data/session';
import { HttpError } from '../transport/http';
import { Group } from '../ui/GroupedList';
import { Icon, IconButton, NavRow, Press, tap } from '../ui/primitives';
import { showToast } from '../ui/Toast';
import { radius, type as typeScale, useTheme } from '../ui/theme';

type LoginSession = { id: number; createdAt: number; expiresAt: number; lastSeenAt: number; ip: string; userAgent: string; current: boolean };

export default function SessionsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const http = session.http;
  const kind = session.active?.kind;
  const [items, setItems] = useState<LoginSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!http) return;
    setLoading(true);
    setError('');
    try {
      const data = await http.get('/api/auth/sessions');
      const list: LoginSession[] = Array.isArray(data?.items) ? data.items : [];
      setItems([...list].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt));
    } catch (err: any) {
      setError(err instanceof HttpError && err.status === 0 ? '连接不上服务器' : '读取登录设备失败');
    } finally {
      setLoading(false);
    }
  }, [http]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = (item: LoginSession) => {
    if (item.current) {
      Alert.alert('退出当前设备？', '退出后需要重新登录这个服务器，其他设备不受影响。', [
        { text: '取消', style: 'cancel' },
        { text: '退出当前设备', style: 'destructive', onPress: () => void session.signOut() },
      ]);
      return;
    }
    const device = describeSessionUserAgent(item.userAgent).label;
    Alert.alert('撤销这台设备的登录？', `${device}${item.ip ? ` · ${item.ip}` : ''}\n撤销后该设备需要重新登录，聊天内容不受影响。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '撤销登录',
        style: 'destructive',
        onPress: async () => {
          if (!http) return;
          setBusyId(item.id);
          try {
            await http.delete(`/api/auth/sessions/${item.id}`);
            tap('medium');
            showToast('该设备的登录已撤销');
            setItems((list) => list.filter((x) => x.id !== item.id));
          } catch (err: any) {
            if (err?.body?.error === 'session_not_found') {
              showToast('这条登录已经失效或被撤销');
              setItems((list) => list.filter((x) => x.id !== item.id));
            } else showToast('撤销失败，请稍后重试');
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  };

  const others = items.filter((x) => !x.current).length;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top }} testID="sessions-page">
      <NavRow
        theme={theme}
        title="登录设备"
        subtitle={session.active?.name}
        left={<IconButton icon={ChevronLeft} theme={theme} label="返回" onPress={() => router.back()} testID="sessions-back" />}
        right={<IconButton icon={RefreshCw} theme={theme} size={19} label="刷新" onPress={load} testID="sessions-refresh" />}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={loading && items.length > 0} onRefresh={load} />}
        keyboardShouldPersistTaps="handled"
      >
        {loading && !items.length ? <ActivityIndicator style={{ marginTop: 40 }} color={theme.muted} /> : null}
        {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
        {items.length ? (
          <Group
            theme={theme}
            title={`有效登录 · ${items.length} 个${others ? `（其他设备 ${others}）` : ''}`}
            footer="撤销只影响目标设备，不会删除聊天内容。最近活动最多每 5 分钟更新一次。"
          >
            {items.map((item) => {
              const device = describeSessionUserAgent(item.userAgent);
              return (
                <View key={item.id} style={styles.row} testID={`login-session-${item.id}`}>
                  <View style={[styles.tile, { backgroundColor: theme.surfaceSoft }]}>
                    <Icon as={device.deviceKind === 'mobile' ? Smartphone : Monitor} size={18} color={theme.text} />
                  </View>
                  <View style={styles.main}>
                    <Text numberOfLines={1} style={[styles.title, { color: theme.textStrong }]}>{device.label}</Text>
                    <View style={styles.metaLine}>
                      {item.current ? (
                        <View style={styles.badge}>
                          <View style={[styles.dot, { backgroundColor: theme.success }]} />
                          <Text style={[styles.badgeText, { color: theme.success }]}>当前设备</Text>
                        </View>
                      ) : null}
                      <Text numberOfLines={1} style={[styles.meta, styles.metaText, { color: theme.muted }]}>
                        {[device.version ? `版本 ${device.version}` : '', item.ip || 'IP 未记录', `最近活动 ${relativeSessionTime(item.lastSeenAt)}`].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                      {`登录 ${formatSessionTime(item.createdAt)} · 有效至 ${formatSessionTime(item.expiresAt)}`}
                    </Text>
                  </View>
                  <Press
                    onPress={() => revoke(item)}
                    disabled={busyId === item.id}
                    style={[styles.action, { borderColor: theme.border }]}
                    testID={`login-session-revoke-${item.id}`}
                  >
                    {busyId === item.id ? (
                      <ActivityIndicator size="small" color={theme.muted} />
                    ) : (
                      <Text style={[styles.actionText, { color: item.current ? theme.text : theme.danger }]}>{item.current ? '退出' : '撤销'}</Text>
                    )}
                  </Press>
                </View>
              );
            })}
          </Group>
        ) : null}
        {!loading && !items.length && !error ? <Text style={[styles.empty, { color: theme.muted }]}>没有有效登录</Text> : null}
        {kind === 'managed' || kind === 'gateway' ? <AccountForm gateway={kind === 'gateway'} /> : null}
        {kind === 'controller' ? (
          <Group theme={theme} footer="主控通过 Web Secret Key + Telegram 审批登录，没有账号密码。">
            <View style={styles.row}>
              <View style={[styles.tile, { backgroundColor: theme.surfaceSoft }]}>
                <Icon as={Globe} size={18} color={theme.text} />
              </View>
              <Text style={[styles.title, { color: theme.text, flex: 1 }]}>登录方式：Telegram 审批</Text>
            </View>
          </Group>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** 修改账号与密码（子实例本地账号 12–1024 位；网关账号任意非空，并提示弱密码）。成功后所有设备退出。 */
function AccountForm({ gateway }: { gateway: boolean }) {
  const theme = useTheme();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const minimum = gateway ? 1 : 12;
  const hint = gateway ? passwordHint(password) : '';

  const clear = () => {
    setCurrent('');
    setPassword('');
    setConfirmation('');
  };

  const save = async () => {
    if (busy || !session.http) return;
    setError('');
    if (password.length < minimum || password.length > 1024) return setError(minimum > 1 ? `新密码需要 ${minimum}–1024 个字符。` : '请输入新密码。');
    if (password !== confirmation) return setError('两次输入的新密码不一致。');
    if (!current) return setError('请填写当前密码。');
    setBusy(true);
    try {
      const result = await session.http.post('/api/auth/password/change', {
        currentPassword: current,
        password,
        ...(username.trim() ? { username: username.trim() } : {}),
      });
      if (result?.ok !== true) throw new Error('change_failed');
      showToast('账号密码已修改，请重新登录');
      await session.signOut();
    } catch (err: any) {
      const status = err?.status;
      setError(status === 429 ? '尝试过于频繁，请稍后重试。' : status === 403 ? '当前密码未通过验证，请重新输入。' : '账号密码未确认修改成功，请检查连接后重新登录核实。');
    } finally {
      clear();
      setBusy(false);
    }
  };

  const field = (label: string, value: string, onChange: (v: string) => void, secure: boolean, testID: string, placeholder?: string) => (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.subtle }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        maxLength={secure ? 1024 : 128}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bg }]}
        testID={testID}
      />
    </View>
  );

  return (
    <Group theme={theme} title="账号" footer={open ? '修改成功后，这个服务器上的所有设备（包括本机）都会退出登录。' : undefined}>
      <Press onPress={() => setOpen((v) => !v)} style={styles.row} pressedStyle={{ backgroundColor: theme.hover }} testID="account-toggle">
        <View style={[styles.tile, { backgroundColor: theme.surfaceSoft }]}>
          <Icon as={KeyRound} size={18} color={theme.text} />
        </View>
        <View style={styles.main}>
          <Text style={[styles.title, { color: theme.textStrong }]}>修改账号与密码</Text>
          {session.active?.username ? <Text style={[styles.meta, { color: theme.muted }]}>当前账号 {session.active.username}</Text> : null}
        </View>
      </Press>
      {open ? (
        <View style={styles.form}>
          {field('新用户名（留空保持原值）', username, setUsername, false, 'account-username')}
          {field('当前密码', current, setCurrent, true, 'account-current')}
          {field('新密码', password, setPassword, true, 'account-password', gateway ? undefined : '至少 12 个字符')}
          {hint ? <Text style={[styles.hint, { color: theme.warning }]}>{hint}</Text> : null}
          {field('再次输入新密码', confirmation, setConfirmation, true, 'account-confirm')}
          {error ? <Text style={[styles.hint, { color: theme.danger }]}>{error}</Text> : null}
          <Press
            onPress={save}
            disabled={busy || !current || !password || !confirmation}
            style={[styles.submit, { backgroundColor: theme.button, opacity: busy || !current || !password || !confirmation ? 0.5 : 1 }]}
            testID="account-save"
          >
            {busy ? <ActivityIndicator color={theme.buttonText} /> : <Text style={[styles.submitText, { color: theme.buttonText }]}>修改并退出所有设备</Text>}
          </Press>
        </View>
      ) : null}
    </Group>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, minHeight: 56 },
  tile: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, minWidth: 0, gap: 2 },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { flexShrink: 1 },
  title: { fontSize: 15.5, fontWeight: '500', flexShrink: 1 },
  meta: { fontSize: 12.5 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 12.5, fontWeight: '500' },
  action: { minWidth: 56, height: 32, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  actionText: { fontSize: 13.5, fontWeight: '500' },
  error: { fontSize: typeScale.small, marginHorizontal: 20, marginTop: 16 },
  empty: { fontSize: typeScale.small, textAlign: 'center', marginTop: 40 },
  form: { paddingHorizontal: 14, paddingBottom: 14, gap: 10 },
  field: { gap: 5 },
  label: { fontSize: 12.5 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  hint: { fontSize: 12.5, lineHeight: 18 },
  submit: { height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  submitText: { fontSize: 15, fontWeight: '600' },
});

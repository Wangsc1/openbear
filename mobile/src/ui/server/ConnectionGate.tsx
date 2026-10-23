/**
 * 连接门：根据当前服务器的连接状态决定显示什么。
 *   none    —— 还没添加任何服务器：添加服务器向导；
 *   login   —— 当前服务器需要（重新）登录：登录页，可切换到其他服务器；
 *   offline —— 连不上：显示错误、重试、切换服务器；令牌保留；
 *   loading —— 正在确认会话；
 *   ready   —— 正常显示 App。
 */
import { router } from 'expo-router';
import { CloudOff, Server } from 'lucide-react-native';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../../data/session';
import { Icon, Press } from '../primitives';
import { radius, type as typeScale, useTheme } from '../theme';
import { ServerConnect } from './ServerConnect';

export function ConnectionGate({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const session = useSession();
  if (session.state === 'ready') return <>{children}</>;
  if (session.state === 'none') return <ServerConnect />;
  if (session.state === 'login' && session.active) {
    return (
      <View style={{ flex: 1 }}>
        <ServerConnect key={session.active.id} reloginId={session.active.id} />
        {session.servers.length > 1 ? <SwitchLink /> : null}
      </View>
    );
  }
  if (session.state === 'offline') {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]} testID="connection-offline">
        <View style={[styles.mark, { backgroundColor: theme.surfaceSoft }]}>
          <Icon as={CloudOff} size={26} color={theme.textStrong} />
        </View>
        <Text style={[styles.title, { color: theme.textStrong }]}>连接不上 {session.active?.name}</Text>
        <Text style={[styles.hint, { color: theme.subtle }]}>{session.active?.baseUrl}</Text>
        {session.error ? <Text style={[styles.hint, { color: theme.muted }]}>{session.error}</Text> : null}
        <Press onPress={session.retry} style={[styles.button, { backgroundColor: theme.button }]} testID="connection-retry">
          <Text style={[styles.buttonText, { color: theme.buttonText }]}>重试</Text>
        </Press>
        {session.servers.length > 1 ? <SwitchLink inline /> : null}
      </View>
    );
  }
  return (
    <View style={[styles.center, { backgroundColor: theme.bg }]} testID="connection-loading">
      <ActivityIndicator color={theme.muted} />
      {session.active ? <Text style={[styles.hint, { color: theme.muted }]}>正在连接 {session.active.name}</Text> : null}
    </View>
  );
}

function SwitchLink({ inline }: { inline?: boolean }) {
  const theme = useTheme();
  return (
    <Press
      onPress={() => router.push('/servers')}
      style={[inline ? styles.linkInline : styles.link, { borderColor: theme.border }]}
      testID="connection-switch-server"
    >
      <Icon as={Server} size={16} color={theme.text} />
      <Text style={{ color: theme.text, fontSize: typeScale.small }}>切换到其他服务器</Text>
    </Press>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  mark: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  hint: { fontSize: typeScale.small, lineHeight: typeScale.smallLine, textAlign: 'center' },
  button: { borderRadius: radius.md, height: 46, paddingHorizontal: 36, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  link: { position: 'absolute', bottom: 40, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth },
  linkInline: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, marginTop: 4 },
});

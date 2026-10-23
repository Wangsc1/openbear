/**
 * “设置” Tab：iOS 设置风格的分组卡片。
 * - 服务器：当前服务器（点按进入多服务器管理）、实时连接状态、登录设备、退出登录；
 * - 外观：跟随系统（本轮只显示）；
 * - 通知：占位；
 * - 开发者：列表库开关（LegendList / FlashList）、Markdown 对比页入口（P0 调试功能挪到这里）；
 * - 关于：版本号。
 */
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Bell, Code, FlaskConical, Info, Layers, LogOut, MonitorSmartphone, Server, SunMoon, Wifi } from 'lucide-react-native';
import React from 'react';
import { Alert, Platform, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { useSession } from '../../data/session';
import { Group, Row, SoonBadge, TabPage } from '../../ui/GroupedList';
import { Segmented } from '../../ui/primitives';
import { type Theme, useTheme } from '../../ui/theme';

function StatusDot({ theme, ok }: { theme: Theme; ok: boolean }) {
  return (
    <View style={styles.status}>
      <View style={[styles.dot, { backgroundColor: ok ? theme.success : theme.danger }]} />
      <Text style={[styles.statusText, { color: theme.muted }]}>{ok ? '已连接' : '未连接'}</Text>
    </View>
  );
}

export default function SettingsTab() {
  const theme = useTheme();
  const session = useSession();
  const scheme = useColorScheme();
  const version = Constants.expoConfig?.version || '—';
  const active = session.active;
  const kindLabel = active ? { controller: '主控', managed: '实例', gateway: '访问网关' }[active.kind] : '';

  return (
    <TabPage title="设置" testID="settings-page">
      <Group theme={theme} title="服务器" footer={`已添加 ${session.servers.length} 个服务器。点“服务器”可以添加、切换或删除。`}>
        <Row
          theme={theme}
          icon={Server}
          title={active?.name || '未设置'}
          subtitle={active ? [kindLabel, active.username, active.version].filter(Boolean).join(' · ') + `\n${active.baseUrl}` : undefined}
          onPress={() => router.push('/servers')}
          testID="settings-server"
        />
        <Row theme={theme} icon={Wifi} title="实时连接" accessory={<StatusDot theme={theme} ok={session.globalConnected} />} />
        <Row theme={theme} icon={MonitorSmartphone} title="登录设备" subtitle={session.active?.kind === 'controller' ? undefined : '查看登录、修改账号与密码'} onPress={() => router.push('/sessions')} testID="settings-sessions" />
        <Row
          theme={theme}
          icon={LogOut}
          iconTint={theme.danger}
          title="退出登录"
          onPress={() =>
            Alert.alert('退出登录', `退出 ${active?.name || '当前服务器'}？下次需要重新登录。`, [
              { text: '取消', style: 'cancel' },
              { text: '退出', style: 'destructive', onPress: () => void session.signOut() },
            ])
          }
          chevron={false}
          testID="settings-logout"
        />
      </Group>

      <Group theme={theme} title="外观">
        <Row theme={theme} icon={SunMoon} title="深浅色" subtitle={`当前为${scheme === 'dark' ? '深色' : '浅色'}`} value="跟随系统" />
      </Group>

      <Group theme={theme} title="通知" footer="会话等待回答、运行完成或失败时提醒你。">
        <Row theme={theme} icon={Bell} title="推送通知" accessory={<SoonBadge theme={theme} />} />
      </Group>

      <Group theme={theme} title="开发者" footer="仅用于开发期对比测试。">
        <Row
          theme={theme}
          icon={Layers}
          title="对话列表实现"
          accessory={
            <View style={styles.seg} testID="settings-list-impl">
              <Segmented
                theme={theme}
                value={session.listImpl}
                onChange={(key) => session.setListImpl(key as 'legend' | 'flash')}
                items={[
                  { key: 'legend', label: 'Legend' },
                  { key: 'flash', label: 'Flash' },
                ]}
              />
            </View>
          }
        />
        <Row theme={theme} icon={FlaskConical} title="Markdown 对比页" onPress={() => router.push('/mdlab')} testID="open-mdlab" />
        <Row theme={theme} icon={Code} title="代码编辑器" onPress={() => router.push('/editorlab')} testID="open-editorlab" />
        <Row theme={theme} icon={Layers} title="共享界面件" onPress={() => router.push('/uilab')} testID="open-uilab" />
      </Group>

      <Group theme={theme} title="关于">
        <Row theme={theme} icon={Info} title="版本" value={`${version}${__DEV__ ? '（开发构建）' : ''}`} />
        <Row theme={theme} icon={Code} title="平台" value={`${Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS} ${String(Platform.Version)}`} />
      </Group>
    </TabPage>
  );
}

const styles = StyleSheet.create({
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 14 },
  seg: { width: 148 },
});

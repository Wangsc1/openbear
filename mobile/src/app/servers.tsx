/**
 * 服务器（多服务器管理）：App 里添加的全部 OpenBear 地址。
 * 点按切换；每项可重命名、退出登录、删除；底部“添加服务器”。
 * 与主控的“实例管理”是两回事：这里只管 App 连接哪些地址。
 */
import { router } from 'expo-router';
import { Check, ChevronLeft, Ellipsis, LogOut, Pencil, Plus, Server, ShieldCheck, Trash2 } from 'lucide-react-native';
import React, { useState } from 'react';
import { Alert, Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '../data/session';
import type { SavedServer } from '../data/servers';
import { ActionMenu, type MenuItem } from '../ui/ActionMenu';
import { Group } from '../ui/GroupedList';
import { Icon, IconButton, NavRow, Press, tap } from '../ui/primitives';
import { ServerConnect } from '../ui/server/ServerConnect';
import { radius, type as typeScale, useTheme } from '../ui/theme';

const KIND: Record<string, string> = { controller: '主控', managed: '实例', gateway: '访问网关' };

export default function ServersScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ server: SavedServer; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<SavedServer | null>(null);
  const [name, setName] = useState('');

  const items = (server: SavedServer): MenuItem[] => [
    { key: 'rename', label: '重命名', icon: Pencil, onPress: () => { setRenaming(server); setName(server.name); } },
    { key: 'logout', label: '退出登录', icon: LogOut, onPress: () => void session.signOut(server.id) },
    {
      key: 'remove',
      label: '删除服务器',
      icon: Trash2,
      destructive: true,
      onPress: () =>
        Alert.alert('删除服务器', `从 App 中移除“${server.name}”？服务器上的数据不受影响。`, [
          { text: '取消', style: 'cancel' },
          { text: '删除', style: 'destructive', onPress: () => void session.removeServer(server.id) },
        ]),
    },
  ];

  if (adding)
    return (
      <ServerConnect
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          router.back();
        }}
      />
    );

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top }} testID="servers-page">
      <NavRow
        theme={theme}
        title="服务器"
        left={<IconButton icon={ChevronLeft} theme={theme} label="返回" onPress={() => router.back()} testID="servers-back" />}
        right={<IconButton icon={Plus} theme={theme} label="添加服务器" onPress={() => setAdding(true)} testID="servers-add" />}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <Group theme={theme} title="已添加" footer="点按切换。每个服务器单独登录，互不影响。">
          {session.servers.map((server) => {
            const current = server.id === session.active?.id;
            return (
              <Press
                key={server.id}
                testID={`server-${server.id}`}
                onPress={() => {
                  tap('select');
                  void session.switchServer(server.id).then(() => router.back());
                }}
                onLongPress={(e) => setMenu({ server, x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
                style={styles.row}
                pressedStyle={{ backgroundColor: theme.hover }}
              >
                <View style={[styles.tile, { backgroundColor: theme.surfaceSoft }]}>
                  <Icon as={server.kind === 'gateway' ? ShieldCheck : Server} size={18} color={theme.text} />
                </View>
                <View style={styles.main}>
                  <Text numberOfLines={1} style={[styles.name, { color: theme.textStrong }]}>{server.name}</Text>
                  <Text numberOfLines={1} style={[styles.sub, { color: theme.muted }]}>
                    {[KIND[server.kind], server.username, server.version, server.baseUrl.replace(/^https?:\/\//, '')].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                {current ? <Icon as={Check} size={18} color={theme.textStrong} /> : null}
                <IconButton
                  icon={Ellipsis}
                  theme={theme}
                  size={17}
                  color={theme.subtle}
                  label="更多"
                  testID={`server-more-${server.id}`}
                  onPress={() => setMenu({ server, x: 9999, y: 160 })}
                />
              </Press>
            );
          })}
        </Group>
        <Group theme={theme}>
          <Press onPress={() => setAdding(true)} style={styles.row} pressedStyle={{ backgroundColor: theme.hover }} testID="servers-add-row">
            <View style={[styles.tile, { backgroundColor: theme.surfaceSoft }]}>
              <Icon as={Plus} size={18} color={theme.text} />
            </View>
            <Text style={[styles.name, { color: theme.textStrong }]}>添加服务器</Text>
          </Press>
        </Group>
      </ScrollView>

      <ActionMenu
        visible={Boolean(menu)}
        anchor={menu ? { x: menu.x, y: menu.y, align: 'right' } : null}
        title={menu?.server.name}
        items={menu ? items(menu.server) : []}
        dim
        onClose={() => setMenu(null)}
      />

      <Modal visible={Boolean(renaming)} transparent animationType="fade" onRequestClose={() => setRenaming(null)}>
        <View style={[styles.mask, { backgroundColor: theme.mask }]}>
          <View style={[styles.dialog, { backgroundColor: theme.panel }]}>
            <Text style={[styles.dialogTitle, { color: theme.textStrong }]}>重命名服务器</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              autoFocus
              style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bg }]}
              testID="server-rename-input"
            />
            <View style={styles.dialogButtons}>
              <Press onPress={() => setRenaming(null)} style={styles.dialogButton}>
                <Text style={{ color: theme.subtle, fontSize: 16 }}>取消</Text>
              </Press>
              <Press
                onPress={() => {
                  if (renaming) void session.renameServer(renaming.id, name);
                  setRenaming(null);
                }}
                style={styles.dialogButton}
                testID="server-rename-save"
              >
                <Text style={{ color: theme.textStrong, fontSize: 16, fontWeight: '600' }}>保存</Text>
              </Press>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14, paddingRight: 6, minHeight: 60 },
  tile: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, minWidth: 0, paddingVertical: 10 },
  name: { fontSize: 16, fontWeight: '500' },
  sub: { fontSize: 12.5, marginTop: 2 },
  mask: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  dialog: { width: '100%', maxWidth: 360, borderRadius: radius.xl, padding: 20, gap: 14 },
  dialogTitle: { fontSize: 17, fontWeight: '600' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: typeScale.body },
  dialogButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  dialogButton: { paddingHorizontal: 14, paddingVertical: 8 },
});

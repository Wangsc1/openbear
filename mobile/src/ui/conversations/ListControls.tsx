/**
 * 会话列表顶部控件：搜索框（本地按标题/目录过滤）与筛选 Chip（全部 / 运行中 N / 待处理 N / 目录）。
 */
import { Search, X } from 'lucide-react-native';
import React from 'react';
import { Platform, ScrollView, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import { Chip, Icon, Press } from '../primitives';
import type { Theme } from '../theme';
import { type Counts, type Filter, filterKey } from './listModel';

export function SearchField({ theme, value, onChange, placeholder = '搜索会话与目录', autoFocus, style, testID = 'conv-search' }: { theme: Theme; value: string; onChange(v: string): void; placeholder?: string; autoFocus?: boolean; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View style={[styles.search, { backgroundColor: theme.hover }, style]}>
      <Icon as={Search} size={16} strokeWidth={1.9} color={theme.muted} />
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="never"
        selectionColor={theme.textStrong}
        cursorColor={theme.textStrong}
        style={[styles.input, { color: theme.text }]}
      />
      {value ? (
        <Press onPress={() => onChange('')} hitSlop={10} accessibilityLabel="清除搜索" style={[styles.clear, { backgroundColor: theme.muted }]} pressedStyle={{ opacity: 0.6 }}>
          <Icon as={X} size={11} strokeWidth={2.6} color={theme.bg} />
        </Press>
      ) : null}
    </View>
  );
}

export function FilterChips({ theme, counts, filter, onChange, showFolders = true, style }: { theme: Theme; counts: Counts; filter: Filter; onChange(f: Filter): void; showFolders?: boolean; style?: StyleProp<ViewStyle> }) {
  const key = filterKey(filter);
  const toggle = (next: Filter) => onChange(filterKey(next) === key ? { kind: 'all' } : next);
  const runDot = (on: boolean) => <View style={[styles.dot, { backgroundColor: on ? theme.buttonText : theme.blue }]} />;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.chips, style]} style={styles.chipScroll}>
      <Chip theme={theme} testID="chip-all" label="全部" selected={key === 'all'} onPress={() => onChange({ kind: 'all' })} />
      <Chip theme={theme} testID="chip-running" label={`运行中 ${counts.running}`} leading={runDot(key === 'running')} selected={key === 'running'} onPress={() => toggle({ kind: 'running' })} />
      <Chip theme={theme} testID="chip-waiting" label={`待处理 ${counts.waiting}`} selected={key === 'waiting'} onPress={() => toggle({ kind: 'waiting' })} />
      {showFolders
        ? counts.folders.map((f) => (
            <Chip key={f.name} theme={theme} testID={`chip-folder-${f.name}`} label={f.name} selected={key === `folder:${f.name}`} onPress={() => toggle({ kind: 'folder', name: f.name })} />
          ))
        : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  search: { height: 38, borderRadius: 11, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  input: { flex: 1, fontSize: 15, paddingVertical: 0, height: 38, ...(Platform.OS === 'android' ? { includeFontPadding: false } : null) },
  clear: { width: 17, height: 17, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  chipScroll: { flexGrow: 0 },
  chips: { gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 12 },
  dot: { width: 5, height: 5, borderRadius: 3 },
});

/** 上下文编辑器的小件：小按钮、角色标签、提示条、分节标题、单选行。 */
import type { LucideIcon } from 'lucide-react-native';
import { Check, X } from 'lucide-react-native';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Icon, Press, tap } from '../ui';
import type { Theme } from '../ui/theme';

export function SmallButton({ theme, label, icon, onPress, disabled, danger, primary, busy, testID }: { theme: Theme; label: string; icon?: LucideIcon; onPress?: () => void; disabled?: boolean; danger?: boolean; primary?: boolean; busy?: boolean; testID?: string }) {
  const color = primary ? theme.buttonText : danger ? theme.danger : theme.text;
  return (
    <Press
      onPress={onPress}
      disabled={disabled || busy}
      style={[styles.btn, primary ? { backgroundColor: theme.button, borderColor: 'transparent' } : { borderColor: theme.border }, (disabled && !busy) && { opacity: 0.4 }]}
      pressedStyle={{ backgroundColor: primary ? theme.button : theme.hover, opacity: 0.85 }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }}
      testID={testID}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : icon ? <Icon as={icon} size={15} strokeWidth={1.9} color={color} /> : null}
      <Text numberOfLines={1} style={[styles.btnText, { color, fontWeight: primary ? '600' : '500' }]}>
        {label}
      </Text>
    </Press>
  );
}

export function RoleTag({ theme, role }: { theme: Theme; role: string }) {
  const [fg, bg] = role === 'assistant' ? [theme.violet, theme.violetSoft] : role === 'tool' ? [theme.warning, theme.warningSoft] : role === 'user' ? [theme.textStrong, theme.selected] : [theme.danger, theme.dangerSoft];
  return (
    <View style={[styles.role, { backgroundColor: bg }]}>
      <Text style={[styles.roleText, { color: fg }]}>{role || '?'}</Text>
    </View>
  );
}

export function Banner({ theme, tone, text, onClose, action, testID }: { theme: Theme; tone: 'error' | 'notice' | 'warning'; text: string; onClose?: () => void; action?: React.ReactNode; testID?: string }) {
  const [fg, bg] = tone === 'error' ? [theme.danger, theme.dangerSoft] : tone === 'warning' ? [theme.warning, theme.warningSoft] : [theme.success, theme.successSoft];
  return (
    <View style={[styles.banner, { backgroundColor: bg }]} accessibilityRole={tone === 'error' ? 'alert' : undefined} testID={testID}>
      <Text style={[styles.bannerText, { color: fg }]}>{text}</Text>
      {action}
      {onClose ? (
        <Press onPress={onClose} hitSlop={10} accessibilityLabel="关闭提示" style={styles.bannerClose}>
          <Icon as={X} size={15} color={fg} />
        </Press>
      ) : null}
    </View>
  );
}

export function SectionHead({ theme, title, detail, right }: { theme: Theme; title: string; detail?: string; right?: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.flex}>
        <Text style={[styles.sectionTitle, { color: theme.textStrong }]}>{title}</Text>
        {detail ? <Text style={[styles.sectionDetail, { color: theme.muted }]}>{detail}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function RadioRow({ theme, label, detail, checked, onPress, testID }: { theme: Theme; label: string; detail?: string; checked: boolean; onPress(): void; testID?: string }) {
  return (
    <Press
      onPress={() => {
        tap('select');
        onPress();
      }}
      style={[styles.radio, { borderColor: checked ? theme.textStrong : theme.border }]}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      testID={testID}
    >
      <View style={[styles.radioDot, { borderColor: checked ? theme.textStrong : theme.border }]}>{checked ? <View style={[styles.radioInner, { backgroundColor: theme.textStrong }]} /> : null}</View>
      <View style={styles.flex}>
        <Text style={[styles.radioLabel, { color: theme.text }]}>{label}</Text>
        {detail ? <Text style={[styles.sectionDetail, { color: theme.muted }]}>{detail}</Text> : null}
      </View>
    </Press>
  );
}

export function CheckBox({ theme, checked }: { theme: Theme; checked: boolean }) {
  return (
    <View style={[styles.check, checked ? { backgroundColor: theme.button, borderColor: theme.button } : { borderColor: theme.border }]}>
      {checked ? <Icon as={Check} size={14} strokeWidth={2.6} color={theme.buttonText} /> : null}
    </View>
  );
}

export function ImpactList({ theme, lines }: { theme: Theme; lines: { label: string; path: string }[] }) {
  if (!lines.length) return null;
  return (
    <View style={[styles.impact, { backgroundColor: theme.codeBg }]}>
      {lines.map((line, i) => (
        <Text key={`${line.path}-${i}`} style={[styles.impactText, { color: theme.text }]}>
          <Text style={{ color: theme.muted }}>{`${line.label} · `}</Text>
          <Text style={styles.mono}>{line.path}</Text>
        </Text>
      ))}
    </View>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 40, paddingHorizontal: 13, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  btnText: { fontSize: 14 },
  role: { height: 20, paddingHorizontal: 7, borderRadius: 6, justifyContent: 'center' },
  roleText: { fontSize: 11.5, fontWeight: '600' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, marginHorizontal: 12, marginTop: 8 },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  bannerClose: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  section: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  sectionTitle: { fontSize: 14.5, fontWeight: '600' },
  sectionDetail: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  radio: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, minHeight: 48 },
  radioDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5 },
  radioLabel: { fontSize: 15 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  impact: { borderRadius: 10, padding: 10, gap: 4, maxHeight: 220 },
  impactText: { fontSize: 12.5, lineHeight: 18 },
  mono: { fontFamily: 'monospace', fontSize: 12 },
});

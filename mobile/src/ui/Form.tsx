/**
 * 表单件（管理页面共用）：放在 GroupedList 的 Group 里使用，和设置页的行保持同一套样式。
 * - FieldRow：标签 + 说明 + 右侧内容（值、开关、按钮）；
 * - TextField：带标签的单行/多行输入（16px 防 iOS 聚焦放大），可显示错误；
 * - SwitchRow：标签 + 系统开关；
 * - SelectRow：标签 + 当前值 + 箭头，点按打开选择面板（OptionSheet）；
 * - OptionSheet：单选/多选面板（底部 Sheet），选项可带说明；
 * - SaveBar：页面底部“保存/取消”栏，脏数据时出现，保存中禁用；
 * - ConfirmSheet：危险操作确认（替代 Alert，可写说明、可要求输入名字确认）。
 */
import type { LucideIcon } from 'lucide-react-native';
import { Check, ChevronRight } from 'lucide-react-native';
import React, { forwardRef, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Switch, Text, TextInput, type TextInputProps, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, Press, tap } from './primitives';
import { Sheet, SheetScroll } from './Sheet';
import { radius, useTheme } from './theme';

export function FieldRow({ label, detail, icon, children, onPress, testID }: { label: string; detail?: string; icon?: LucideIcon; children?: React.ReactNode; onPress?: () => void; testID?: string }) {
  const theme = useTheme();
  const body = (
    <>
      {icon ? (
        <View style={[styles.iconTile, { backgroundColor: theme.surfaceSoft }]}>
          <Icon as={icon} size={17} strokeWidth={1.8} color={theme.text} />
        </View>
      ) : null}
      <View style={styles.rowMain}>
        <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
        {detail ? <Text style={[styles.detail, { color: theme.muted }]}>{detail}</Text> : null}
      </View>
      {children}
    </>
  );
  if (!onPress) return <View style={styles.row} testID={testID}>{body}</View>;
  return (
    <Press onPress={onPress} style={styles.row} pressedStyle={{ backgroundColor: theme.hover }} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      {body}
    </Press>
  );
}

export const TextField = forwardRef<TextInput, TextInputProps & { label?: string; hint?: string; error?: string; mono?: boolean }>(function TextField({ label, hint, error, multiline, mono, style, ...input }, ref) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.fieldLabel, { color: theme.subtle }]}>{label}</Text> : null}
      <TextInput
        ref={ref}
        placeholderTextColor={theme.muted}
        autoCorrect={false}
        autoCapitalize="none"
        selectionColor={theme.textStrong}
        cursorColor={theme.textStrong}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        {...input}
        style={[
          styles.input,
          { color: theme.text, backgroundColor: theme.bg, borderColor: error ? theme.danger : theme.border },
          multiline ? styles.inputMulti : null,
          mono ? styles.mono : null,
          style,
        ]}
      />
      {error ? <Text style={[styles.hint, { color: theme.danger }]}>{error}</Text> : hint ? <Text style={[styles.hint, { color: theme.muted }]}>{hint}</Text> : null}
    </View>
  );
});

export function SwitchRow({ label, detail, icon, value, onChange, disabled, testID }: { label: string; detail?: string; icon?: LucideIcon; value: boolean; onChange(v: boolean): void; disabled?: boolean; testID?: string }) {
  const theme = useTheme();
  return (
    <FieldRow label={label} detail={detail} icon={icon} testID={testID}>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          tap('select');
          onChange(v);
        }}
        trackColor={{ true: theme.button, false: theme.surfaceSoft }}
        thumbColor={Platform.OS === 'android' ? (value ? theme.buttonText : theme.panel) : undefined}
        ios_backgroundColor={theme.surfaceSoft}
        testID={testID ? `${testID}-switch` : undefined}
      />
    </FieldRow>
  );
}

export type Option<T extends string = string> = { value: T; label: string; detail?: string; icon?: LucideIcon; disabled?: boolean };

export function SelectRow<T extends string>({ label, detail, icon, value, options, onChange, title, multiple, placeholder = '未设置', testID }: {
  label: string;
  detail?: string;
  icon?: LucideIcon;
  value: T | T[];
  options: Option<T>[];
  onChange(v: any): void;
  title?: string;
  multiple?: boolean;
  placeholder?: string;
  testID?: string;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const text = values.map((v) => options.find((o) => o.value === v)?.label || v).join('、') || placeholder;
  return (
    <>
      <FieldRow label={label} detail={detail} icon={icon} onPress={() => setOpen(true)} testID={testID}>
        <Text numberOfLines={1} style={[styles.value, { color: theme.muted }]}>{text}</Text>
        <Icon as={ChevronRight} size={17} strokeWidth={1.8} color={theme.disabled} />
      </FieldRow>
      <OptionSheet visible={open} title={title || label} options={options} value={value} multiple={multiple} onClose={() => setOpen(false)} onChange={onChange} testID={testID ? `${testID}-sheet` : undefined} />
    </>
  );
}

export function OptionSheet<T extends string>({ visible, title, options, value, multiple, onChange, onClose, testID }: {
  visible: boolean;
  title?: string;
  options: Option<T>[];
  value: T | T[];
  multiple?: boolean;
  onChange(v: any): void;
  onClose(): void;
  testID?: string;
}) {
  const theme = useTheme();
  const selected = new Set(Array.isArray(value) ? value : [value]);
  return (
    <Sheet visible={visible} title={title} onClose={onClose} testID={testID}>
      <SheetScroll>
        {options.map((option) => {
          const on = selected.has(option.value);
          return (
            <Press
              key={option.value}
              disabled={option.disabled}
              onPress={() => {
                tap('select');
                if (multiple) {
                  const next = new Set(selected);
                  if (on) next.delete(option.value);
                  else next.add(option.value);
                  onChange([...next]);
                } else {
                  onChange(option.value);
                  onClose();
                }
              }}
              style={[styles.option, option.disabled ? { opacity: 0.45 } : null]}
              pressedStyle={{ backgroundColor: theme.hover }}
              accessibilityRole={multiple ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: on, disabled: option.disabled }}
              testID={testID ? `${testID}-${option.value}` : undefined}
            >
              {option.icon ? <Icon as={option.icon} size={18} color={theme.subtle} /> : null}
              <View style={styles.rowMain}>
                <Text style={[styles.label, { color: theme.textStrong, fontWeight: on ? '600' : '400' }]}>{option.label}</Text>
                {option.detail ? <Text style={[styles.detail, { color: theme.muted }]}>{option.detail}</Text> : null}
              </View>
              {on ? <Icon as={Check} size={18} strokeWidth={2.2} color={theme.textStrong} /> : null}
            </Press>
          );
        })}
      </SheetScroll>
    </Sheet>
  );
}

export function SaveBar({ visible, saving, onSave, onCancel, saveLabel = '保存', error }: { visible: boolean; saving?: boolean; onSave(): void; onCancel?: () => void; saveLabel?: string; error?: string }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  if (!visible) return null;
  return (
    <View style={[styles.saveBar, { backgroundColor: theme.panel, borderTopColor: theme.line, paddingBottom: Math.max(insets.bottom, 10) }]} testID="save-bar">
      {error ? <Text numberOfLines={2} style={[styles.saveError, { color: theme.danger }]}>{error}</Text> : <View style={{ flex: 1 }} />}
      {onCancel ? (
        <Press onPress={onCancel} disabled={saving} style={[styles.saveSecondary, { borderColor: theme.border }]} testID="save-cancel">
          <Text style={{ color: theme.text, fontSize: 15 }}>取消</Text>
        </Press>
      ) : null}
      <Press onPress={onSave} disabled={saving} style={[styles.savePrimary, { backgroundColor: theme.button, opacity: saving ? 0.6 : 1 }]} testID="save-submit">
        {saving ? <ActivityIndicator color={theme.buttonText} /> : <Text style={{ color: theme.buttonText, fontSize: 15, fontWeight: '600' }}>{saveLabel}</Text>}
      </Press>
    </View>
  );
}

/** 危险操作确认：requireText 时需要输入完全一致的文字才能确认（例如删除实例时输入实例名）。 */
export function ConfirmSheet({ visible, title, message, confirmLabel = '确认', destructive = true, requireText, busy, onConfirm, onClose, children }: {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
  requireText?: string;
  busy?: boolean;
  onConfirm(): void;
  onClose(): void;
  children?: React.ReactNode;
}) {
  const theme = useTheme();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (visible) setTyped('');
  }, [visible]);
  const ready = !requireText || typed.trim() === requireText;
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <View style={styles.confirmBody}>
        {message ? <Text style={[styles.confirmText, { color: theme.text }]}>{message}</Text> : null}
        {children}
        {requireText ? (
          <TextField label={`输入“${requireText}”确认`} value={typed} onChangeText={setTyped} placeholder={requireText} testID="confirm-input" />
        ) : null}
        <Press
          onPress={onConfirm}
          disabled={!ready || busy}
          style={[styles.confirmButton, { backgroundColor: destructive ? theme.danger : theme.button, opacity: !ready || busy ? 0.5 : 1 }]}
          testID="confirm-submit"
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={[styles.confirmButtonText, { color: destructive ? '#fff' : theme.buttonText }]}>{confirmLabel}</Text>}
        </Press>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 52 },
  iconTile: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  rowMain: { flex: 1, minWidth: 0 },
  label: { fontSize: 15.5 },
  detail: { fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  value: { fontSize: 14.5, maxWidth: '50%', textAlign: 'right' },
  field: { gap: 6, paddingHorizontal: 14, paddingVertical: 8 },
  fieldLabel: { fontSize: 12.5, fontWeight: '500' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 11 : 8, fontSize: 16 },
  inputMulti: { minHeight: 96, paddingTop: 10 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 14.5 },
  hint: { fontSize: 12.5, lineHeight: 17 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, minHeight: 52, paddingVertical: 8 },
  saveBar: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, paddingHorizontal: 16 },
  saveError: { flex: 1, fontSize: 12.5 },
  saveSecondary: { height: 40, paddingHorizontal: 18, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  savePrimary: { height: 40, minWidth: 88, paddingHorizontal: 20, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  confirmBody: { paddingHorizontal: 20, paddingBottom: 6, gap: 12 },
  confirmText: { fontSize: 15, lineHeight: 22 },
  confirmButton: { height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  confirmButtonText: { fontSize: 16, fontWeight: '600' },
});

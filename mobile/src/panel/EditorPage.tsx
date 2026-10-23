/**
 * 全屏编辑页（模态）：长表单、代码编辑器用。底部 Sheet 在键盘弹起时整体上移，高内容会把标题和前几个输入框推出屏幕；
 * 编辑页改为整屏：导航栏“取消 / 标题 / 保存”，正文随键盘收缩（react-native-keyboard-controller 的 KeyboardAvoidingView）。
 * 系统返回 = 取消（由调用方决定是否先确认放弃修改）。iOS 用 pageSheet 样式，Android 用整屏滑入。
 */
import React from 'react';
import { ActivityIndicator, Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Press, useTheme } from '../ui';

type Props = {
  visible: boolean;
  title: string;
  subtitle?: string;
  onCancel(): void;
  onSave?: () => void;
  saveLabel?: string;
  saving?: boolean;
  saveDisabled?: boolean;
  cancelLabel?: string;
  /** 页底固定区（错误提示、次要操作） */
  footer?: React.ReactNode;
  children: React.ReactNode;
  testID?: string;
};

export function EditorPage({ visible, title, subtitle, onCancel, onSave, saveLabel = '保存', saving, saveDisabled, cancelLabel = '取消', footer, children, testID }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const ios = Platform.OS === 'ios';
  const top = ios ? 8 : insets.top;
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={ios ? 'pageSheet' : undefined}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onCancel}
    >
      <View style={[styles.root, { backgroundColor: theme.panel }]} testID={testID}>
        <View style={[styles.bar, { paddingTop: top, borderBottomColor: theme.line }]}>
          <Press onPress={onCancel} disabled={saving} style={[styles.side, { width: 132 }]} hitSlop={6} accessibilityRole="button" accessibilityLabel={cancelLabel} testID={testID ? `${testID}-cancel` : undefined}>
            <Text style={[styles.cancel, { color: theme.text }]}>{cancelLabel}</Text>
          </Press>
          <View style={styles.titleBox}>
            <Text numberOfLines={1} style={[styles.title, { color: theme.textStrong }]}>
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted }]}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <View style={[styles.side, styles.sideRight]}>
            {onSave ? (
              <Press
                onPress={onSave}
                disabled={saving || saveDisabled}
                style={[styles.save, { backgroundColor: theme.button, opacity: saveDisabled && !saving ? 0.4 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel={saveLabel}
                accessibilityState={{ disabled: Boolean(saving || saveDisabled), busy: Boolean(saving) }}
                testID={testID ? `${testID}-save` : undefined}
              >
                {saving ? <ActivityIndicator size="small" color={theme.buttonText} /> : <Text numberOfLines={1} style={[styles.saveText, { color: theme.buttonText }]}>{saveLabel}</Text>}
              </Press>
            ) : null}
          </View>
        </View>
        <KeyboardAvoidingView behavior="padding" style={styles.flex} keyboardVerticalOffset={0}>
          <View style={styles.flex}>{children}</View>
          {footer ? <View style={[styles.footer, { borderTopColor: theme.line, paddingBottom: Math.max(insets.bottom, 10) }]}>{footer}</View> : <View style={{ height: insets.bottom }} />}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 6, minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth },
  side: { minWidth: 72, maxWidth: 132, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  sideRight: { alignItems: 'flex-end', width: 132 },
  titleBox: { flex: 1, minWidth: 0, alignItems: 'center' },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 11.5, marginTop: 1 },
  cancel: { fontSize: 16 },
  save: { height: 36, minWidth: 64, paddingHorizontal: 14, borderRadius: 18, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  saveText: { fontSize: 15, fontWeight: '600' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, paddingHorizontal: 16 },
});

/**
 * 外接键盘检测（B3-46）：手机软键盘保持“回车换行、按钮发送”；只有检测到硬件键盘时才按桌面规则
 * （Enter 发送、Shift+Enter 换行）。
 *
 * Android：RN 的 onKeyPress 只由输入法连接（软键盘）触发；硬件键盘的按键直接进 EditText，不会有 onKeyPress。
 * 所以“插入了一个换行，前后 ~150ms 内没有软键盘的 Enter 按键事件”= 硬件键盘的 Enter。第一次检测到后：
 *   - 这次换行撤回并当作 Enter 处理（发送或在选择器里插入）；
 *   - 之后 TextInput 用 submitBehavior="submit"：硬件 Enter（无修饰键）走 onSubmitEditing，
 *     Shift+Enter 由系统插入换行（TextView 只对无修饰键的 Enter 触发编辑器动作）。
 * iOS：外接键盘连接时系统只显示一条很矮的快捷栏（< 120pt），据此判断。
 * 检测结果在本次 App 运行期间有效（拔掉键盘后重启 App 恢复手机规则）。
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';

let detected = false;
const listeners = new Set<(value: boolean) => void>();

export function markHardwareKeyboard() {
  if (detected) return;
  detected = true;
  for (const fn of [...listeners]) fn(true);
}

export function useHardwareKeyboard(): boolean {
  const [value, setValue] = useState(detected);
  const visible = useKeyboardState((state) => state.isVisible);
  const height = useKeyboardState((state) => state.height);
  useEffect(() => {
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  if (Platform.OS === 'ios') return value || (visible && height > 0 && height < 120);
  return value;
}

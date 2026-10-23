/**
 * 开发者页：共享界面件验收（面板下拉关闭、键盘跟随、表单、确认、选择）。
 */
import { router } from 'expo-router';
import { Bell, ChevronLeft, Cpu, Folder, Trash2 } from 'lucide-react-native';
import React, { useRef, useState } from 'react';
import { ScrollView, Text, type TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmSheet, FieldRow, Group, IconButton, NavRow, Press, SaveBar, SelectRow, Sheet, SheetScroll, SwitchRow, TextField, showToast, useTheme } from '../ui';

export default function UiLab() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [sheet, setSheet] = useState<'none' | 'long' | 'form'>('none');
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState('');
  const [notify, setNotify] = useState(true);
  const [model, setModel] = useState('gpt');
  const [tags, setTags] = useState<string[]>(['a']);
  const dirty = name.length > 0;
  const folderName = useRef<TextInput>(null);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top }} testID="uilab">
      <NavRow theme={theme} title="共享界面件" left={<IconButton icon={ChevronLeft} theme={theme} label="返回" onPress={() => router.back()} />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
        <Group theme={theme} title="面板">
          <FieldRow label="长内容面板" detail="内部滚动；滚到顶后继续下拉关闭" onPress={() => setSheet('long')} testID="uilab-long" />
          <FieldRow label="表单面板" detail="输入框聚焦时面板随键盘上移" onPress={() => setSheet('form')} testID="uilab-form" />
          <FieldRow label="危险操作确认" detail="需要输入名字才能确认" icon={Trash2} onPress={() => setConfirm(true)} testID="uilab-confirm" />
        </Group>
        <Group theme={theme} title="表单">
          <TextField label="名称" placeholder="输入后底部出现保存栏" value={name} onChangeText={setName} testID="uilab-name" />
          <SwitchRow label="完成时通知" icon={Bell} value={notify} onChange={setNotify} testID="uilab-switch" />
          <SelectRow
            label="模型"
            icon={Cpu}
            value={model}
            onChange={setModel}
            options={[
              { value: 'gpt', label: 'gpt-6.1-sol', detail: 'OpenAI' },
              { value: 'opus', label: 'claude-opus-5-5', detail: 'Anthropic' },
              { value: 'glm', label: 'GLM-5.3', detail: '智谱' },
            ]}
            testID="uilab-model"
          />
          <SelectRow
            label="目录"
            icon={Folder}
            multiple
            value={tags}
            onChange={setTags}
            options={[
              { value: 'a', label: 'OpenBear' },
              { value: 'b', label: 'Net & VPS' },
              { value: 'c', label: '公司' },
            ]}
            testID="uilab-tags"
          />
        </Group>
      </ScrollView>
      <SaveBar visible={dirty} onCancel={() => setName('')} onSave={() => showToast(`已保存：${name}`)} />

      <Sheet visible={sheet === 'long'} title="长内容" subtitle="下拉、点遮罩或右上角关闭" onClose={() => setSheet('none')} full testID="uilab-long-sheet">
        <SheetScroll contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}>
          {Array.from({ length: 60 }, (_, i) => (
            <Text key={i} style={{ color: theme.text, fontSize: 15, lineHeight: 26 }}>{`第 ${i + 1} 行：面板内容可以独立滚动，滚到顶部后继续下拉会关闭面板。`}</Text>
          ))}
        </SheetScroll>
      </Sheet>

      <Sheet
        visible={sheet === 'form'}
        title="新建目录"
        onClose={() => setSheet('none')}
        initialFocus={folderName}
        testID="uilab-form-sheet"
        footer={
          <Press onPress={() => setSheet('none')} style={{ height: 46, borderRadius: 12, backgroundColor: theme.button, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: theme.buttonText, fontSize: 16, fontWeight: '600' }}>创建</Text>
          </Press>
        }
      >
        <TextField ref={folderName} label="目录名称" placeholder="例如：项目资料" testID="uilab-folder-name" />
        <TextField label="目录提示词" placeholder="可选" multiline />
      </Sheet>

      <ConfirmSheet
        visible={confirm}
        title="删除实例"
        message="删除后实例的容器和数据卷都会被清除，无法恢复。"
        confirmLabel="删除"
        requireText="test-child-1"
        onConfirm={() => {
          setConfirm(false);
          showToast('已确认');
        }}
        onClose={() => setConfirm(false)}
      />
    </View>
  );
}

/**
 * 全文阅读页（设计 5.2-2 的对策）：超长回复切成多行后不能跨块选择，长按正文进入此页，
 * 整条回复用一个 commonmark flavor 的 EnrichedMarkdownText 渲染（单个原生 TextView，可整段任意选择复制）。
 *
 * 导航栏：共享 GlassBar + NavRow（返回 / “全文” / 复制全部），内容从玻璃栏下面滑过；
 * 正文字号、行高、颜色与对话正文一致（同一份 markdownStyleFor），阅读宽度限 readingWidth 居中。
 */
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { Check, ChevronLeft, Copy } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { preprocessForMd4c } from '../chat/markdown/BodyRenderer';
import { markdownStyleFor } from '../chat/markdown/EnrichedBody';
import { useToast } from '../chat/sheetKit';
import { useSession } from '../data/session';
import { GlassBar, IconButton, NAV_ROW_HEIGHT, NavRow, tap } from '../ui/primitives';
import { readingWidth, type as typeScale, useTheme } from '../ui/theme';

export default function FullText() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { uuid, messageId } = useLocalSearchParams<{ uuid: string; messageId: string }>();
  const session = useSession();
  const markdown = session.storeFor(String(uuid)).answerText(String(messageId));
  const [copied, setCopied] = useState(false);
  const [toastNode, toast] = useToast(theme, insets.bottom + 24);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copyAll = async () => {
    tap('light');
    await Clipboard.setStringAsync(markdown);
    setCopied(true);
    toast('已复制全文');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  const top = insets.top + NAV_ROW_HEIGHT;
  const chars = markdown.length;

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]} testID="fulltext">
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: top + 12, paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.column}>
          {markdown ? (
            <EnrichedMarkdownText
              flavor="commonmark"
              markdown={preprocessForMd4c(markdown)}
              markdownStyle={markdownStyleFor(theme)}
              md4cFlags={{ hardSoftBreaks: true, latexMath: true }}
              selectable
            />
          ) : (
            <Text style={[styles.empty, { color: theme.muted }]}>这条回复没有可显示的正文</Text>
          )}
          {chars ? <Text style={[styles.foot, { color: theme.muted }]}>{`共 ${chars.toLocaleString()} 字 · 长按可选择任意文字`}</Text> : null}
        </View>
      </ScrollView>
      <GlassBar theme={theme}>
        <NavRow
          theme={theme}
          title="全文"
          left={<IconButton icon={ChevronLeft} theme={theme} label="返回" onPress={() => router.back()} testID="fulltext-back" size={24} />}
          right={<IconButton icon={copied ? Check : Copy} theme={theme} label="复制全部" onPress={() => void copyAll()} testID="fulltext-copy" size={20} />}
        />
      </GlassBar>
      {toastNode}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 18, alignItems: 'center' },
  column: { width: '100%', maxWidth: readingWidth },
  empty: { fontSize: typeScale.small, textAlign: 'center', marginTop: 40 },
  foot: { fontSize: typeScale.tiny, marginTop: 20, textAlign: 'center' },
});

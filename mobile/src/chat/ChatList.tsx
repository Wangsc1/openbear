/**
 * 消息列表：LegendList 与 FlashList 两种实现，同一接口，可由开关切换对比（设计 5.2-2、P0-3）。
 *
 * 共同约定：
 *  - 不反转列表；首屏定位到底部；
 *  - 向上接近顶部时 onStartReached -> 数据层 loadEarlier()，prepend 时由列表库保持可见位置
 *    （LegendList: maintainVisibleContentPosition；FlashList v2: 默认开启的 maintainVisibleContentPosition）；
 *  - 用户停在底部时流式输出自动跟随；上翻阅读时不跟随，显示“有新内容”。
 */
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { rowRecycleType, type ChatRow } from '../data/rows';
import type { ListImpl } from '../data/session';
import type { Theme } from '../ui/theme';
import type { BodyRenderer } from './markdown/BodyRenderer';
import { RowView, type RowActions } from './RowViews';

export type ChatListHandle = {
  scrollToEnd(animated?: boolean): void;
  scrollToTop(animated?: boolean): void;
  /** b2：跳到某一行（轮次导航、搜索定位、待处理定位）；viewPosition 0=顶部 0.5=居中 */
  scrollToIndex(index: number, animated?: boolean, viewPosition?: number): void;
};

type Props = {
  impl: ListImpl;
  rows: ChatRow[];
  theme: Theme;
  renderer: BodyRenderer;
  actions: RowActions;
  padH: number;
  /** 顶部留白（玻璃导航栏高度，内容从栏下滑过） */
  topInset?: number;
  bottomInset: number;
  onStartReached(): void;
  onScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void;
  onLoad?(info: { elapsedTimeInMs: number }): void;
  header?: React.ReactElement | null;
  /** b2：“跟随最新消息”开关（默认 true = 原行为； false 时停在底部也不自动跟随） */
  followEnd?: boolean;
  /** b2：可见行变化（轮次导航的“当前轮”） */
  onViewableItemsChanged?: (info: { viewableItems: Array<{ index: number | null; item: ChatRow }> }) => void;
  /** b2：空列表时显示（空会话欢迎页） */
  empty?: React.ReactElement | null;
};

const keyExtractor = (row: ChatRow) => row.key;
const getItemType = (row: ChatRow) => rowRecycleType(row);

export const ChatList = forwardRef<ChatListHandle, Props>(function ChatList(props, ref) {
  const legendRef = useRef<LegendListRef>(null);
  const flashRef = useRef<FlashListRef<ChatRow>>(null);
  const { impl, rows, theme, renderer, actions, padH } = props;

  useImperativeHandle(ref, () => ({
    scrollToEnd(animated = false) {
      if (impl === 'legend') void legendRef.current?.scrollToEnd({ animated });
      else flashRef.current?.scrollToEnd({ animated });
    },
    scrollToTop(animated = false) {
      if (impl === 'legend') void legendRef.current?.scrollToOffset({ offset: 0, animated });
      else flashRef.current?.scrollToOffset({ offset: 0, animated });
    },
    scrollToIndex(index: number, animated = false, viewPosition = 0) {
      if (index < 0) return;
      if (impl === 'legend') void legendRef.current?.scrollToIndex({ index, animated, viewPosition, viewOffset: props.topInset ?? 0 });
      else flashRef.current?.scrollToIndex({ index, animated, viewPosition, viewOffset: props.topInset ?? 0 });
    },
  }), [impl, props.topInset]);

  const renderItem = useCallback(
    ({ item }: { item: ChatRow }) => <RowView row={item} theme={theme} renderer={renderer} actions={actions} padH={padH} />,
    [theme, renderer, actions, padH],
  );

  const contentContainerStyle = { paddingTop: props.topInset ?? 0, paddingBottom: props.bottomInset };

  if (impl === 'legend') {
    return (
      <LegendList
        ref={legendRef}
        testID="chat-list"
        data={rows}
        extraData={theme}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        estimatedItemSize={72}
        recycleItems
        initialScrollAtEnd
        maintainScrollAtEnd={props.followEnd ?? true}
        maintainScrollAtEndThreshold={0.08}
        onViewableItemsChanged={props.onViewableItemsChanged as any}
        ListEmptyComponent={props.empty}
        maintainVisibleContentPosition
        onStartReached={props.onStartReached}
        onStartReachedThreshold={0.6}
        onScroll={props.onScroll}
        onLoad={props.onLoad}
        drawDistance={600}
        ListHeaderComponent={props.header}
        contentContainerStyle={contentContainerStyle}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      />
    );
  }
  return (
    <FlashList
      ref={flashRef}
      testID="chat-list"
      data={rows}
      extraData={theme}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      getItemType={getItemType}
      maintainVisibleContentPosition={{ autoscrollToBottomThreshold: props.followEnd === false ? undefined : 0.08, startRenderingFromBottom: true, animateAutoScrollToBottom: false }}
      onViewableItemsChanged={props.onViewableItemsChanged as any}
      ListEmptyComponent={props.empty}
      onStartReached={props.onStartReached}
      onStartReachedThreshold={0.6}
      onScroll={props.onScroll}
      onLoad={props.onLoad}
      drawDistance={600}
      ListHeaderComponent={props.header}
      contentContainerStyle={contentContainerStyle}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    />
  );
});

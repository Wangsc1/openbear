/**
 * 开发专用帧采样（仅 __DEV__）：用于 iOS 模拟器上比较两种列表库。
 * Instruments 的 Animation Hitches 不支持模拟器，这里退而在应用内采样：
 *  - UI 线程：reanimated useFrameCallback 的相邻帧间隔（原生驱动的滚动在 UI 线程，最能反映滑动流畅度）；
 *  - JS 线程：requestAnimationFrame 的相邻帧间隔（反映 JS 侧投影/渲染的阻塞）。
 * 由 ConversationView 挂载；每 5 秒、以及卸载时输出一次汇总到 Metro 日志：
 *   [perf] frames thread=ui list=legend n=… p50=… p90=… p99=… over16=…% over33=…% maxMs=…
 * 只统计“有滚动或数据变化”的时间段：间隔 > 250ms 的视为空闲，不计入。
 */
import React, { useEffect, useRef } from 'react';
import { useFrameCallback } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

type Props = { label: string };

function summarize(thread: string, label: string, intervals: number[]): string | null {
  const v = intervals.filter((x) => x > 0 && x < 250).sort((a, b) => a - b);
  if (v.length < 30) return null;
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))].toFixed(1);
  const over = (ms: number) => ((v.filter((x) => x > ms).length / v.length) * 100).toFixed(1);
  return `[perf] frames thread=${thread} list=${label} n=${v.length} p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} over16=${over(16.7 * 1.5)}% over33=${over(33.4)}% maxMs=${v[v.length - 1].toFixed(1)}`;
}

function FrameSamplerImpl({ label }: Props) {
  const ui = useRef<number[]>([]);
  const js = useRef<number[]>([]);
  const pushUi = (dt: number) => {
    ui.current.push(dt);
  };
  useFrameCallback((info) => {
    'worklet';
    if (info.timeSincePreviousFrame != null) scheduleOnRN(pushUi, info.timeSincePreviousFrame);
  });
  useEffect(() => {
    let last = 0;
    let raf = 0;
    const tick = (t: number) => {
      if (last) js.current.push(t - last);
      last = t;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const flush = () => {
      const a = summarize('ui', label, ui.current);
      const b = summarize('js', label, js.current);
      if (a) console.log(a);
      if (b) console.log(b);
      ui.current = [];
      js.current = [];
    };
    const timer = setInterval(flush, 5000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
      flush();
    };
  }, [label]);
  return null;
}

export function FrameSampler(props: Props) {
  return __DEV__ ? <FrameSamplerImpl {...props} /> : null;
}

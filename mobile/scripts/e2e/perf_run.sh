#!/bin/bash
# 列表库性能对比（模拟器软件渲染，只能做相对比较）。
# 用法：perf_run.sh <legend|flash> <outDir> [serial]
# 前提：App 在会话列表页，模拟后端 :18787，Metro :8081。
IMPL=$1; OUT=$2; SERIAL=${3:-emulator-5554}
PKG=dev.openbear.app
ADB="${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb -s $SERIAL"
mkdir -p "$OUT"
dump() { $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; $ADB shell cat /sdcard/ui.xml; }
center() { dump | python3 -c "
import sys,re
x=sys.stdin.read()
m=re.search(r'resource-id=\"[^\"]*$1\"[^>]*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',x)
print((int(m.group(1))+int(m.group(3)))//2,(int(m.group(2))+int(m.group(4)))//2) if m else print('')"; }
fling_up() { for i in $(seq 1 $1); do $ADB shell input swipe 540 700 540 2000 90; done; }
fling_down() { for i in $(seq 1 $1); do $ADB shell input swipe 540 2000 540 700 90; done; }

$ADB shell input tap $(center list-impl-$IMPL); sleep 1
# 1) 打开最长对话（3 次，取 logcat 中的 perf 打点）
$ADB logcat -c
for run in 1 2 3; do
  $ADB shell input tap $(center conv-a6a877ad)
  sleep 7
  $ADB shell input keyevent KEYCODE_BACK
  sleep 2
done
$ADB logcat -d -s ReactNativeJS:V | grep "\[perf\]" > "$OUT/open-$IMPL.log"

# 2) 快速滑动 + 向上翻页（gfxinfo）
$ADB shell input tap $(center conv-a6a877ad); sleep 7
$ADB shell dumpsys meminfo $PKG > "$OUT/meminfo-$IMPL-opened.txt"
$ADB logcat -c
$ADB shell dumpsys gfxinfo $PKG reset > /dev/null
fling_up 12
sleep 2
fling_down 12
sleep 2
$ADB shell dumpsys gfxinfo $PKG > "$OUT/gfx-$IMPL-fling.txt"
$ADB logcat -d -s ReactNativeJS:V | grep "\[perf\]" > "$OUT/page-$IMPL.log"
$ADB exec-out screencap -p > "$OUT/after-fling-$IMPL.png"
STATUS=$(dump | python3 -c "
import sys,re,html
x=sys.stdin.read(); m=re.search(r'text=\"([^\"]*)\"[^>]*resource-id=\"[^\"]*conversation-status\"',x); print(html.unescape(m.group(1)) if m else '')")
echo "status after fling: $STATUS" > "$OUT/status-$IMPL.txt"

# 3) 向上翻页跳动检测：记录翻页前后首个可见行的文本与位置
$ADB shell input tap $(center jump-top); sleep 2
dump > "$OUT/ui-before-page-$IMPL.xml"
$ADB shell input swipe 540 900 540 1400 400   # 慢速向上拖动，触发 onStartReached
sleep 4
dump > "$OUT/ui-after-page-$IMPL.xml"
$ADB shell dumpsys meminfo $PKG > "$OUT/meminfo-$IMPL-paged.txt"
$ADB shell input keyevent KEYCODE_BACK; sleep 2

# 4) 流式回放期间滚动（gfxinfo）：打开 d8e18cc9，发送一条消息触发回放，回放中上下滑动
$ADB shell input tap $(center conv-d8e18cc9); sleep 6
$ADB shell input tap $(center composer-input); sleep 1
$ADB shell input text "perf-$IMPL"
$ADB shell input keyevent KEYCODE_BACK; sleep 1
$ADB shell input tap $(center composer-send); sleep 8
$ADB shell dumpsys gfxinfo $PKG reset > /dev/null
for i in 1 2 3 4 5 6; do $ADB shell input swipe 540 900 540 1700 250; sleep 0.5; $ADB shell input swipe 540 1700 540 900 250; sleep 0.5; done
$ADB shell dumpsys gfxinfo $PKG > "$OUT/gfx-$IMPL-stream.txt"
$ADB exec-out screencap -p > "$OUT/during-stream-$IMPL.png"
$ADB shell dumpsys meminfo $PKG > "$OUT/meminfo-$IMPL-stream.txt"
$ADB shell input keyevent KEYCODE_BACK; sleep 2
echo done

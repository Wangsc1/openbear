#!/bin/bash
# 在模拟器上逐例截取 App（enriched-markdown）渲染的 Markdown 用例。
# 前提：App 已在会话列表页；模拟后端提供 /api/mock/md-cases。
# 用法：app_shots.sh <outDir> <light|dark> [serial]
OUT=${1:-${OPENBEAR_MOBILE_DATA:-$HOME/.cache/openbear-mobile}/md-compare/app}
THEME=${2:-light}
SERIAL=${3:-emulator-5554}
ADB="${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb -s $SERIAL"
mkdir -p "$OUT"
center() { # 根据 testID 取控件中心坐标
  $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  $ADB shell cat /sdcard/ui.xml | python3 -c "
import sys,re
x=sys.stdin.read()
m=re.search(r'resource-id=\"[^\"]*$1\"[^>]*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',x) or re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"[^>]*?resource-id=\"[^\"]*$1\"',x)
print((int(m.group(1))+int(m.group(3)))//2,(int(m.group(2))+int(m.group(4)))//2) if m else print('')"
}
label() {
  $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  $ADB shell cat /sdcard/ui.xml | python3 -c "
import sys,re,html
x=sys.stdin.read(); m=re.search(r'text=\"([^\"]*)\"[^>]*resource-id=\"[^\"]*mdlab-label\"',x)
print(html.unescape(m.group(1)) if m else '')"
}
$ADB shell input tap $(center open-mdlab)
sleep 3
NEXT=$(center mdlab-next)
for i in $(seq 1 11); do
  sleep 2
  L=$(label)
  ID=$(echo "$L" | sed -E 's/.* · ([a-z0-9-]+) \(.*/\1/')
  $ADB exec-out screencap -p > "$OUT/app-$THEME-$ID.png"
  echo "$i $ID"
  $ADB shell input tap $NEXT
done
# 流式：回到第 1 例，打开流式开关，在三个时刻截图
for i in $(seq 1 11); do $ADB shell input tap $(center mdlab-prev); done
sleep 1
$ADB shell input tap $(center mdlab-stream)
sleep 0.8; $ADB exec-out screencap -p > "$OUT/app-$THEME-stream-t1.png"
sleep 1.2; $ADB exec-out screencap -p > "$OUT/app-$THEME-stream-t2.png"
sleep 2.5; $ADB exec-out screencap -p > "$OUT/app-$THEME-stream-t3.png"
$ADB shell input tap $(center mdlab-stream)
$ADB shell input tap $(center mdlab-back)
ls "$OUT" | grep "app-$THEME" | wc -l

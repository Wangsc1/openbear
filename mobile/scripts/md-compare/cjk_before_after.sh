#!/bin/bash
# 在模拟器上截中文强调修复前/后对比（mdlab 第 1 例 cjk-fix-demo；“修复前”直接把原文交给 md4c）。
# 用法：cjk_before_after.sh <outDir> [serial]
OUT=${1:-${OPENBEAR_MOBILE_DATA:-$HOME/.cache/openbear-mobile}/md-compare/cjk}
SERIAL=${2:-emulator-5554}
ADB="${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb -s $SERIAL"
mkdir -p "$OUT"
center() {
  $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  $ADB shell cat /sdcard/ui.xml | python3 -c "
import sys,re
x=sys.stdin.read()
m=re.search(r'resource-id=\"[^\"]*$1\"[^>]*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',x)
print((int(m.group(1))+int(m.group(3)))//2,(int(m.group(2))+int(m.group(4)))//2) if m else print('')"
}
texts() {
  $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  $ADB shell cat /sdcard/ui.xml | python3 -c "
import sys,re,html
x=sys.stdin.read()
for m in re.finditer(r'<node [^>]*?text=\"([^\"]*)\"[^>]*?content-desc=\"([^\"]*)\"',x):
    t=html.unescape(m.group(1) or m.group(2))
    if t and ('*' in t or '强调' in t or '说明' in t or '项' in t): print('  ', t[:90])"
}
$ADB shell input tap $(center open-mdlab); sleep 3
sleep 1; $ADB exec-out screencap -p > "$OUT/after.png"; echo "after:"; texts > "$OUT/after.txt"; cat "$OUT/after.txt"
$ADB shell input tap $(center mdlab-raw); sleep 2
$ADB exec-out screencap -p > "$OUT/before.png"; echo "before:"; texts > "$OUT/before.txt"; cat "$OUT/before.txt"
$ADB shell input tap $(center mdlab-raw); sleep 1
$ADB shell input tap $(center mdlab-back)

#!/bin/bash
# 向上翻页“是否跳动”检测：到顶触发 onStartReached，在新页到达前/后各 dump 一次界面，
# 比较同一锚点文本的纵坐标位移（理想为 0：列表库保持可见位置）。
# 用法：prepend_jump.sh <legend|flash> <outDir> [rounds=3] [serial]
IMPL=$1; OUT=$2; ROUNDS=${3:-3}; SERIAL=${4:-emulator-5554}
ADB="${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb -s $SERIAL"
mkdir -p "$OUT"
dump() { $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; $ADB shell cat /sdcard/ui.xml; }
center() { dump | python3 -c "
import sys,re
x=sys.stdin.read()
m=re.search(r'resource-id=\"[^\"]*$1\"[^>]*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',x)
print((int(m.group(1))+int(m.group(3)))//2,(int(m.group(2))+int(m.group(4)))//2) if m else print('')"; }
$ADB shell input tap $(center list-impl-$IMPL); sleep 1
$ADB shell input tap $(center conv-fed2ce26); sleep 7
TOP=$(center jump-top)
for r in $(seq 1 $ROUNDS); do
  $ADB shell input tap $TOP
  dump > "$OUT/jump-$IMPL-$r-a.xml"
  sleep 5
  dump > "$OUT/jump-$IMPL-$r-b.xml"
done
$ADB shell input keyevent KEYCODE_BACK; sleep 1
python3 - "$OUT" "$IMPL" "$ROUNDS" <<'PY'
import re,html,sys
out,impl,rounds=sys.argv[1],sys.argv[2],int(sys.argv[3])
def rows(f):
    x=open(f,encoding='utf-8',errors='replace').read()
    st=re.search(r'text="([^"]*)"[^>]*resource-id="[^"]*conversation-status"',x)
    r={}
    for m in re.finditer(r'<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',x):
        t=html.unescape(m.group(1) or m.group(2)).strip(); y=int(m.group(4))
        if t and 213<y<2150 and len(t)>6: r.setdefault(t,y)
    return (html.unescape(st.group(1)) if st else ''), r
for i in range(1,rounds+1):
    sa,a=rows(f'{out}/jump-{impl}-{i}-a.xml'); sb,b=rows(f'{out}/jump-{impl}-{i}-b.xml')
    common=[t for t in a if t in b]
    shifts=[b[t]-a[t] for t in common]
    print(f'{impl} round{i}: before="{sa}" after="{sb}" anchors={len(common)} shift_px={sorted(set(shifts))[:5] if shifts else "no common anchor (content replaced)"}')
PY

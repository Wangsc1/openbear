#!/bin/bash
# 逐例导出 App 侧原生渲染结果的无障碍文本树（每个原生 Markdown 片段的 text/content-desc 与位置），
# 用来逐类核对：强调标记是否被吃掉、公式是否渲染（而不是原样显示 $…$）、表格/代码块是否成为独立块等。
# 用法：app_texts.sh <outDir> [serial]
OUT=${1:-${OPENBEAR_MOBILE_DATA:-$HOME/.cache/openbear-mobile}/md-compare/app}
SERIAL=${2:-emulator-5554}
ADB="${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb -s $SERIAL"
dump() { $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; $ADB shell cat /sdcard/ui.xml; }
center() { dump | python3 -c "
import sys,re
x=sys.stdin.read()
m=re.search(r'resource-id=\"[^\"]*$1\"[^>]*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',x)
print((int(m.group(1))+int(m.group(3)))//2,(int(m.group(2))+int(m.group(4)))//2) if m else print('')"; }
$ADB shell input tap $(center open-mdlab); sleep 3
NEXT=$(center mdlab-next)
for i in $(seq 1 11); do
  sleep 1.5
  dump > /tmp/mdui.xml
  python3 - "$OUT" <<'PY'
import re,html,sys,json
x=open('/tmp/mdui.xml',encoding='utf-8',errors='replace').read()
label=re.search(r'text="([^"]*)"[^>]*resource-id="[^"]*mdlab-label"',x)
cid=re.sub(r'.* · ([a-z0-9-]+) \(.*',r'\1',html.unescape(label.group(1))) if label else 'unknown'
nodes=[]
for m in re.finditer(r'<node [^>]*?text="([^"]*)"[^>]*?class="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="([^"]*)"',x):
    t,cls,d,b=m.groups()
    v=html.unescape(t or d)
    if v and 'mdlab' not in v and '上一例' not in v and '下一例' not in v and v not in ('流式','静态','‹'):
        nodes.append({'cls':cls.split('.')[-1],'bounds':b,'text':v})
json.dump(nodes,open(f'{sys.argv[1]}/app-tree-{cid}.json','w'),ensure_ascii=False,indent=1)
print(cid,len(nodes))
PY
  $ADB shell input tap $NEXT
done
$ADB shell input tap $(center mdlab-back)

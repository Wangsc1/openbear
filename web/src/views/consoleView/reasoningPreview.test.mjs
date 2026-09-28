import test from 'node:test';
import assert from 'node:assert/strict';
import {createReasoningPreview, reasoningPreviewState, reasoningPreviewText} from './reasoningPreview.js';

function fixture(initial, width = 30, reduced = false, desktop = false) {
  let now = 0, sequence = 0, content = '', scrollLeft = 0;
  const frames = new Map(), listeners = new Set(), desktopListeners = new Set(), observers = [];
  const counts = {resets:0,appends:0,widthReads:0,scrollWrites:0,maskWrites:0};
  const textNode = {nodeType:3,get data(){return content;},appendData(text){content+=text;counts.appends++;}};
  const track = {style:{},get firstChild(){return content ? textNode : null;},get textContent(){return content;},set textContent(text){content=text;counts.resets++;},get scrollWidth(){counts.widthReads++;return Array.from(content).length * 10;}};
  const viewport = {firstElementChild:track, clientWidth:width,get scrollLeft(){return scrollLeft;},set scrollLeft(value){scrollLeft=value;counts.scrollWrites++;}, dataset:new Proxy({}, {set(target,key,value){counts.maskWrites++;target[key]=value;return true;}})};
  const media = {matches:reduced, addEventListener:(_,fn)=>listeners.add(fn), removeEventListener:(_,fn)=>listeners.delete(fn)};
  const desktopMedia = {matches:desktop,addEventListener:(_,fn)=>desktopListeners.add(fn),removeEventListener:(_,fn)=>desktopListeners.delete(fn)};
  const env = {
    matchMedia:query=>query.includes('prefers-reduced-motion') ? media : desktopMedia,
    requestAnimationFrame:fn=>{frames.set(++sequence,fn);return sequence;},
    cancelAnimationFrame:id=>frames.delete(id),
    ResizeObserver:class {constructor(fn) {this.fn=fn;this.targets=new Set();observers.push(this);} observe(n) {this.targets.add(n);} disconnect() {this.targets.clear();}},
  };
  const player = createReasoningPreview(viewport, reasoningPreviewState(initial), env);
  const step = (dt = 16) => {now+=dt;const jobs=[...frames.values()];frames.clear();jobs.forEach(fn=>fn(now));};
  const settle = () => {let n=0;while(frames.size && n++<300)step();assert.equal(frames.size,0,'animation must stop when caught up');};
  const position=()=>desktopMedia.matches ? (-parseFloat((track.style.transform||'').replace('translate3d(',''))||0) : viewport.scrollLeft;
  return {track,viewport,frames,observers,listeners,desktopListeners,media,desktopMedia,counts,position,player,step,settle,update:text=>player.update(reasoningPreviewState(text))};
}

test('desktop doubles opaque playback speed without per-frame native scrolling or whole-line replacement', () => {
  const target='abcdefghijklmnopqrstuvwxyz'.repeat(300);
  for(const [reduced, rate] of [[false,64],[true,32]]) {
    const f=fixture(opaque(target),900,reduced,true);
    assert.equal(f.track.textContent,target.slice(0,90));
    Object.keys(f.counts).forEach(key=>{f.counts[key]=0;});
    for(let i=0;i<63;i++)f.step();
    assert.equal(f.track.textContent,target.slice(0,90+rate));
    assert.ok(f.position()>(rate-6)*10,'desktop visibly advances at the faster rate');
    assert.equal(f.viewport.scrollLeft,0);assert.equal(f.counts.scrollWrites,0);
    assert.equal(f.counts.resets,0,'steady playback appends to the existing text node');
    assert.ok(f.counts.widthReads<=f.counts.appends+1,'geometry is measured at most once per text update');
    assert.equal(f.counts.maskWrites,1,'overflow mask does not trigger redundant attribute writes');
    assert.equal(f.track.style.willChange,'transform');
    f.player.dispose();assert.equal(f.track.style.transform,'');assert.equal(f.track.style.willChange,'');
    assert.equal(f.frames.size,0);assert.equal(f.desktopListeners.size,0);
  }
});

test('desktop 120Hz frames move fractionally even between character arrivals', () => {
  const f=fixture(opaque('abcdef'.repeat(1000)),776,false,true);
  const positions=[];
  for(let i=0;i<120;i++){f.step(1000/120);positions.push(f.position());}
  for(let i=1;i<positions.length;i++){
    assert.ok(positions[i]>positions[i-1],`frame ${i} advances rather than snapping/stopping on whole characters`);
    assert.ok(positions[i]-positions[i-1]<12,'no one-character jumps between compositor frames');
  }
  assert.ok(positions.some(value=>!Number.isInteger(value)));
  assert.equal(f.counts.scrollWrites,0);f.player.dispose();
});

test('desktop pruning keeps the same continuous visual position and bounds its real-text strip', () => {
  const target=Array.from({length:5000},(_,i)=>String.fromCodePoint(0x10000+i)).join('');
  const f=fixture(opaque(target),900,false,true);
  let previous=0;
  for(let i=0;i<2200;i++){
    f.step();
    const removed=f.track.textContent.codePointAt(0)-0x10000;
    const position=removed*10+f.position();
    assert.ok(position>=previous,`frame ${i} must not jump backwards when pruning`);
    assert.ok(position-previous<20,`frame ${i} must not jump forward when pruning`);
    assert.ok(Array.from(f.track.textContent).length<=1024);
    previous=position;
  }
  assert.ok(f.track.textContent.codePointAt(0)>0x10000,'pruning was exercised');
  assert.ok(f.frames.size);f.player.dispose();
});

test('desktop resize, reduced-motion readable updates and switching to touch preserve the displayed position', () => {
  const f=fixture('a'.repeat(120),900,false,true);
  assert.equal(f.position(),300);
  f.viewport.clientWidth=1100;f.player.sync();f.settle();assert.equal(f.position(),100);
  f.viewport.clientWidth=2000;f.observers[0].fn();f.settle();assert.equal(f.position(),0);assert.equal(f.viewport.dataset.overflow,'false');
  f.viewport.clientWidth=900;f.observers[0].fn();f.settle();assert.equal(f.position(),300);
  f.desktopMedia.matches=false;for(const fn of f.desktopListeners)fn();f.settle();
  assert.equal(f.track.style.transform,'');assert.equal(f.viewport.scrollLeft,300);
  f.desktopMedia.matches=true;for(const fn of f.desktopListeners)fn();f.settle();
  assert.equal(f.position(),300);assert.equal(f.viewport.scrollLeft,0);
  f.media.matches=true;for(const fn of f.listeners)fn();
  f.update('a'.repeat(125));assert.equal(f.position(),350);assert.equal(f.frames.size,0);
  assert.equal(f.track.style.willChange,'');
  const late=[...f.desktopListeners];f.player.dispose();for(const fn of late)fn();
  assert.equal(f.track.style.transform,'');assert.equal(f.frames.size,0);
});

test('desktop readable bursts finish with the exact source tail and release the compositor hint', () => {
  const f=fixture('start',900,false,true);
  const target='start '+ '😀思考 '.repeat(120).trim();
  f.update(target);for(let i=0;i<5;i++)f.step();
  assert.ok(f.track.textContent.length<target.length);f.settle();
  assert.equal(f.track.textContent,target);
  assert.equal(f.position(),f.track.scrollWidth-f.viewport.clientWidth);
  assert.equal(f.track.style.willChange,'');assert.equal(f.counts.scrollWrites,0);
  f.player.dispose();
});

test('preview collapses whitespace to separators instead of dropping earlier lines or joining words', () => {
  assert.equal(reasoningPreviewText('abc def\n g'),'abc def g');
  assert.equal(reasoningPreviewText('  one\t two\r\n\r\n three\u3000四  '),'one two three 四');
  assert.equal(reasoningPreviewText('中文\n下一段'),'中文 下一段');
  assert.equal(reasoningPreviewText(' \t\r\n\u3000'),'');
});

const opaque = text => `加密思考（不可读）\n${text}`;

test('only explicitly encrypted previews remove all whitespace and the display marker', () => {
  const raw=opaque(' ab\tcd\r\n ef\u3000gh ');
  assert.deepEqual(reasoningPreviewState(raw),{encrypted:true,text:'abcdefgh'});
  assert.equal(raw,opaque(' ab\tcd\r\n ef\u3000gh '),'the source is unchanged');
  assert.deepEqual(reasoningPreviewState('abc def\n ghi'),{encrypted:false,text:'abc def ghi'});
  assert.deepEqual(reasoningPreviewState(opaque(' \r\n\t')),{encrypted:true,text:''});
});

test('one large encrypted chunk prefills its real prefix and keeps moving for 15 seconds without more packets', () => {
  const target='abcdefghijklmnopqrstuvwxyz'.repeat(1000);
  const f=fixture(opaque(target));
  assert.equal(f.track.textContent,'abc','mount fills only the first measured line, never the encrypted tail');
  f.step();f.step();assert.equal(f.track.textContent,'abcd');
  for(let i=2;i<63;i++)f.step();
  assert.equal(f.track.textContent,target.slice(0,35),'one second plays 32 additional characters regardless of backlog size');
  const before=f.viewport.scrollLeft;
  for(let i=63;i<938;i++)f.step();
  assert.equal(f.track.textContent,target.slice(0,483));
  assert.ok(f.viewport.scrollLeft>before);assert.equal(f.viewport.dataset.overflow,'true');
  assert.ok(f.frames.size,'playback is still active after 15 seconds with a single packet');
  const painted=f.track.textContent, late=[...f.frames.values()];
  f.player.dispose();assert.equal(f.frames.size,0);
  for(const fn of late)fn(16000);
  f.update(opaque(target+'late'));f.player.sync();f.step();
  assert.equal(f.track.textContent,painted,'ending neither flushes the backlog nor revives a stale player');
  assert.equal(f.frames.size,0);assert.equal(f.listeners.size,0);assert.equal(f.observers[0].targets.size,0);
});

test('native phone/touch layouts at any width still start motion within the first two frames', () => {
  const target='abcdefghijklmnopqrstuvwxyz'.repeat(300);
  for(const width of [180,900,1440]) {
    const f=fixture(opaque(target),width);
    assert.equal(f.track.textContent,target.slice(0,width/10));
    assert.equal(f.viewport.scrollLeft,0);
    f.step();f.step();
    assert.ok(f.viewport.scrollLeft>0,`width ${width} must move without waiting to type an entire line`);
    assert.ok(f.viewport.scrollLeft<10,'motion interpolates between character positions');
    assert.equal(f.track.textContent,target.slice(0,width/10+1));
    f.player.dispose();assert.equal(f.frames.size,0);
  }
  const short=fixture(opaque('abcd'),900);
  assert.equal(short.track.textContent,'abcd');assert.equal(short.frames.size,0,'never fabricate characters just to fill a line');
  short.player.dispose();
});

test('encrypted segments append in order without restarting, duplicating snapshots or accelerating', () => {
  const f=fixture(opaque('abc def'));
  f.step();f.step();assert.equal(f.track.textContent,'abcd');
  f.update(opaque('abc def\n\nghi jkl'));
  f.update(opaque('abc def\n\nghi jkl'));
  f.step();f.step();assert.equal(f.track.textContent,'abcde');
  f.settle();assert.equal(f.track.textContent,'abcdefghijkl');
  f.update(opaque('abc def\n\nghi jkl\n mn'));
  f.settle();assert.equal(f.track.textContent,'abcdefghijklmn');
  f.player.dispose();
});

test('replacement encrypted snapshots reset playback; readable summaries supersede the opaque queue immediately', () => {
  const f=fixture(opaque('abc'.repeat(100)));
  f.step();f.step();assert.equal(f.track.textContent,'abca');
  f.update(opaque('XYZ'.repeat(100)));
  assert.equal(f.track.textContent,'XYZ');assert.equal(f.viewport.scrollLeft,0);
  f.step();f.step();assert.equal(f.track.textContent,'XYZX');
  f.update('Readable summary\nwith spaces');
  assert.equal(f.track.textContent,'Readable summary with spaces');assert.equal(f.frames.size,0);
  f.player.dispose();
});

test('touch reduced-motion retains the existing 16 chars/s playback and 32 chars/s ordinary speed', () => {
  const target='abcdefghijklmnopqrstuvwxyz'.repeat(300);
  const f=fixture(opaque(target),776,true);
  assert.equal(f.track.textContent,target.slice(0,77),'prefill the measured line, not the old static 768-character tail');
  assert.equal(f.viewport.scrollLeft,0);assert.ok(f.frames.size);
  for(let i=0;i<44;i++)f.step();
  assert.ok(f.viewport.scrollLeft>0,'the real reported 776px desktop advances during a 700ms sample');
  assert.equal(f.track.textContent,target.slice(0,88));
  for(let i=44;i<63;i++)f.step();
  assert.equal(f.track.textContent,target.slice(0,93),'reduced motion adds 16 characters/second');
  f.media.matches=false;for(const listener of f.listeners)listener();
  assert.equal(f.track.textContent.length,93,'a preference change does not flush the backlog');
  for(let i=0;i<63;i++)f.step();
  assert.equal(f.track.textContent,target.slice(0,125),'ordinary speed remains 32 characters/second');
  f.player.dispose();assert.equal(f.frames.size,0);
});

test('encrypted playback bounds its rendered strip', () => {
  const f=fixture(opaque('abcdef'.repeat(500)));
  for(let i=0;i<2200;i++)f.step();
  assert.ok(f.track.textContent.length<=1024);
  assert.ok(f.track.textContent.length>=768);assert.ok(f.frames.size);
  const painted=f.track.textContent;
  f.viewport.clientWidth=20000;f.observers[0].fn();for(let i=0;i<100;i++)f.step();
  assert.ok(f.track.textContent.startsWith(painted));assert.equal(f.viewport.dataset.overflow,'false');
  f.player.dispose();
});

test('a three-character viewport keeps f-space-g after a newline and moves progressively', () => {
  const f=fixture('abc def');
  assert.equal(f.viewport.scrollLeft,40);
  f.update('abc def\n g');
  assert.equal(f.track.textContent,'abc def');
  f.step();f.step();
  assert.equal(f.track.textContent,'abc def ');
  assert.ok(f.viewport.scrollLeft>40 && f.viewport.scrollLeft<50,'pixel position interpolates instead of snapping one whole glyph');
  f.settle();
  assert.equal(f.track.textContent,'abc def g');
  assert.equal(f.viewport.scrollLeft,60);
  assert.equal(f.track.textContent.slice(-3),'f g');
  assert.equal(f.viewport.dataset.overflow,'true');
  f.player.dispose();
});

test('packet bursts animate, preserve emoji codepoints and catch up without stale playback', () => {
  const f=fixture('开始');
  const target='开始 '+ '😀思考 '.repeat(60).trim();
  f.update(target);
  for(let i=0;i<5;i++)f.step();
  assert.ok(f.track.textContent.length>2 && f.track.textContent.length<target.length);
  assert.doesNotMatch(f.track.textContent,/[\uD800-\uDBFF]$/u,'never paint half a surrogate pair');
  f.settle();assert.equal(f.track.textContent,target);
  assert.equal(f.frames.size,0,'no decorative scrolling when there is no new content');
  f.player.dispose();
});

test('new snapshots replace the strip and mounting existing text does not replay history', () => {
  const f=fixture('old '.repeat(1000));
  assert.ok(f.track.textContent.length<=768);assert.equal(f.frames.size,0);
  f.update('old '.repeat(1000)+'pending');assert.ok(f.frames.size);
  f.update('a new message');
  assert.equal(f.track.textContent,'a new message');assert.equal(f.frames.size,0);
  f.update('');assert.equal(f.track.textContent,'');assert.equal(f.viewport.scrollLeft,0);
  f.player.dispose();
});

test('long streams bound rendered text while preserving the newest tail', () => {
  const f=fixture('a'.repeat(760));
  f.update('a'.repeat(760)+' b'.repeat(250));f.settle();
  assert.ok(Array.from(f.track.textContent).length<=1024);
  assert.ok(f.track.textContent.endsWith(' b'.repeat(250)));
  assert.equal(f.viewport.scrollLeft,f.track.scrollWidth-f.viewport.clientWidth);
  f.player.dispose();
});

test('resizing follows the same strip and a wide viewport clears overflow', () => {
  const f=fixture('abcdef');
  assert.equal(f.observers[0].targets.size,2);
  f.viewport.clientWidth=20;f.observers[0].fn();f.settle();assert.equal(f.viewport.scrollLeft,40);
  f.viewport.clientWidth=200;f.observers[0].fn();f.settle();assert.equal(f.viewport.scrollLeft,0);
  assert.equal(f.viewport.dataset.overflow,'false');f.player.dispose();
});

test('reduced motion flushes pending text immediately, and disposing releases every callback', () => {
  const f=fixture('abc');f.update('abc def ghi');assert.ok(f.frames.size);
  f.media.matches=true;for(const fn of f.listeners)fn();
  assert.equal(f.track.textContent,'abc def ghi');assert.equal(f.frames.size,0);
  f.update('abc def ghi jkl');assert.equal(f.track.textContent,'abc def ghi jkl');
  f.media.matches=false;f.update('abc def ghi jkl mno');assert.ok(f.frames.size);
  f.player.dispose();assert.equal(f.frames.size,0);assert.equal(f.listeners.size,0);assert.equal(f.observers[0].targets.size,0);
});

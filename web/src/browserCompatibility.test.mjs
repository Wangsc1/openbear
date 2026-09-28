import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {randomUuid} from './utils/randomUuid.js';
import config, {browserTargets, manualChunk} from '../vite.config.js';

const bundled = await build({
  stdin: {contents: `import './browserCompatibility.js';
    import {clone} from './views/consoleView/contextEditor/operations.js';
    globalThis.cloneContext = clone;`, resolveDir: fileURLToPath(new URL('.', import.meta.url))},
  bundle: true, write: false, format: 'iife', platform: 'browser', target: browserTargets,
});
const code = bundled.outputFiles[0].text;
function legacyContext() {
  const context = vm.createContext({});
  vm.runInContext(`delete Array.prototype.at; delete Array.prototype.findLast;
    delete Array.prototype.findLastIndex; delete Object.hasOwn; delete globalThis.structuredClone;`, context);
  vm.runInContext(code, context);
  return expression => vm.runInContext(expression, context);
}

test('legacy API patches execute in a realm without page/worker modern globals', () => {
  const run = legacyContext();
  assert.equal(run('[10, 20].at(-1)'), 20);
  assert.equal(run('[10, 20].at(-3)'), undefined);
  assert.equal(run('Array.prototype.at.call({0: 7, length: 1}, 0)'), 7);
  assert.equal(run('[2, 3, 4].findLast(n => n % 2 === 0)'), 4);
  assert.equal(run('[2, 3, 4].findLastIndex(n => n % 2 === 0)'), 2);
  assert.equal(run('[2].findLastIndex(n => n === 0)'), -1);
  assert.equal(run('Object.hasOwn(Object.create({inherited: 1}), "inherited")'), false);
  assert.equal(run('Object.hasOwn({hasOwnProperty: null, own: undefined}, "own")'), true);
});

test('actual context clone keeps nested data, cycles and binary values without a lossy JSON fallback', () => {
  const run = legacyContext();
  assert.equal(run(`(() => {
    const original = {entries: [{message: {role: 'assistant', content: '中文', opaque: {keep: true}}}],
      absent: undefined, date: new Date(123), bytes: new Uint8Array([3, 5]), map: new Map([['x', {value: 8}]])};
    original.self = original;
    const copied = cloneContext(original);
    copied.entries[0].message.opaque.keep = false;
    return copied !== original && copied.self === copied && original.entries[0].message.opaque.keep
      && copied.entries[0].message.content === '中文' && Object.hasOwn(copied, 'absent')
      && copied.date.getTime() === 123 && copied.bytes[1] === 5 && copied.bytes !== original.bytes
      && copied.map.get('x').value === 8;
  })()`), true);
  assert.equal(run(`(() => { try { cloneContext({f() {}}); } catch (e) { return e.name; } })()`), 'DataCloneError');
});

test('native supported array/object methods are retained', () => {
  const context = vm.createContext({});
  vm.runInContext('globalThis.before = [Array.prototype.at, Array.prototype.findLast, Array.prototype.findLastIndex, Object.hasOwn]', context);
  vm.runInContext(code, context);
  assert.equal(vm.runInContext('before.every((fn, i) => fn === [Array.prototype.at, Array.prototype.findLast, Array.prototype.findLastIndex, Object.hasOwn][i])', context), true);
});

test('UUID keeps native receiver and uses secure v4 fallback on older Safari', () => {
  const native = {randomUUID() {assert.equal(this, native); return 'native';}};
  assert.equal(randomUuid(native), 'native');
  let calls = 0;
  const legacy = {getRandomValues(bytes) {assert.equal(this, legacy); calls++; bytes.fill(255); return bytes;}};
  assert.equal(randomUuid(legacy), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(calls, 1);
  assert.throws(() => randomUuid({}), /安全随机数/);
});

test('both page and worker load compatibility first; build targets and independent chunk are explicit', () => {
  for (const path of ['./main.js', './editor.worker.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source.match(/^import .+$/m)[0], /browserCompatibility\.js/);
  }
  assert.deepEqual(config.build.target, ['safari15', 'chrome87']);
  assert.deepEqual(config.build.cssTarget, config.build.target);
  assert.equal(manualChunk('/project/web/src/browserCompatibility.js'), 'compatibility');
  assert.equal(manualChunk('/project/web/node_modules/core-js/modules/es.array.at.js'), 'compatibility');
  assert.equal(manualChunk('\0commonjsHelpers.js'), 'compatibility');
});

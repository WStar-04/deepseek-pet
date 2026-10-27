/**
 * Linux/X11 全局光标监听（点击穿透兜底通道的输入源）测试。
 *
 * 背景：Electron 在 Linux 上不实现 `setIgnoreMouseEvents(true, { forward: true })` 的鼠标转发；
 * `screen.getCursorScreenPoint()` 在 X11 下又只返回 Chromium 缓存值。两条路一起断，穿透窗口既
 * 收不到 DOM pointermove，兜底轮询也永远读不到新坐标——宠物 hover/点击/拖拽全废。helper 改用
 * `xinput test-xi2 --root` 的 XI2 全局事件流补上光标位置。
 *
 * 这里钉住：① xinput 输出解析（root 行、负坐标、缩放换算、节流）；② main.js 确实把兜底轮询
 * 接到了这个输入源上，而不是继续只读 screen.getCursorScreenPoint()。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { parseXi2RootLine, createXi2Parser } = require(helper + 'linux-pointer.js');

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('parseXi2RootLine —— 从 xinput test-xi2 输出里取全局坐标', () => {
  test('Motion 事件的 root 行（真实鼠标输出）', () => {
    // 实测 `xinput test-xi2 --root`：Motion 块里 root 是物理像素，event 行不是坐标
    assert.deepEqual(parseXi2RootLine('    root: 1651.80/213.90'), { x: 1651.8, y: 213.9 });
    assert.deepEqual(parseXi2RootLine('    root: 2484.00/837.00'), { x: 2484, y: 837 });
  });

  test('负坐标（多屏摆在主屏左侧/上方时是合法值）', () => {
    assert.deepEqual(parseXi2RootLine('    root: -1920.00/-1080.00'), { x: -1920, y: -1080 });
  });

  test('忽略 FocusIn 的 root x/y 行、event 行、表头与空行', () => {
    for (const line of [
      '    root x/y:  1651.00 / 213.00',
      '    event: 1651.80/213.90',
      'EVENT type 6 (Motion)',
      '    windows: root 0x1c9 event 0x1c9 child 0x5c00008',
      '',
      '    root: nope/213.9',
      '    root: 12/34/56',
    ]) {
      assert.equal(parseXi2RootLine(line), null, JSON.stringify(line));
    }
  });
});

describe('createXi2Parser —— 缩放换算与节流', () => {
  test('scale=2：物理像素 → DIP 并四舍五入', () => {
    const points: Array<{ x: number; y: number }> = [];
    const feed = createXi2Parser({ scale: 2, throttleMs: 0, onPoint: (p: { x: number; y: number }) => points.push(p) });
    feed('    root: 2484.00/837.00');
    feed('    root: 2485.00/838.00');
    assert.deepEqual(points, [
      { x: 1242, y: 419 },
      { x: 1243, y: 419 },
    ]);
  });

  test('非法 scale 回落 1；非 root 行不回调', () => {
    const points: Array<{ x: number; y: number }> = [];
    const feed = createXi2Parser({ scale: 0, throttleMs: 0, onPoint: (p: { x: number; y: number }) => points.push(p) });
    feed('    event: 1651.80/213.90');
    feed('    root: 1651.80/213.90');
    assert.deepEqual(points, [{ x: 1652, y: 214 }]);
  });

  test('15ms 节流：高刷鼠标不会把每一行都送进主进程', () => {
    let now = 0;
    const points: Array<{ x: number; y: number }> = [];
    const feed = createXi2Parser({
      throttleMs: 15,
      now: () => now,
      onPoint: (p: { x: number; y: number }) => points.push(p),
    });
    feed('    root: 100.00/100.00');
    now = 5;
    feed('    root: 101.00/101.00');
    now = 14;
    feed('    root: 102.00/102.00');
    now = 15;
    feed('    root: 103.00/103.00');
    assert.deepEqual(points, [
      { x: 100, y: 100 },
      { x: 103, y: 103 },
    ]);
  });
});

describe('窗口夹取守卫 —— Linux WM 夹边后宠物仍能贴到屏幕边缘', () => {
  const sprite = readSource('../../runtime/electron-helper/sprite.js');
  const preload = readSource('../../runtime/electron-helper/preload.js');
  const main = readSource('../../runtime/electron-helper/main.js');

  test('preload 暴露平台标记，渲染端只在 Linux 启用窗口夹取', () => {
    assert.match(preload, /platform: process\.platform/);
    assert.match(sprite, /window\.petBridge && window\.petBridge\.platform === 'linux'/);
    assert.match(sprite, /\? \{ x: 0, y: 0, width: VIEW\.w, height: VIEW\.h \}\s*: null/);
  });

  test('窗口位置交给 placePetWindow 夹取，宠物在窗口内滑动（不再用 window.screenX 反算）', () => {
    assert.doesNotMatch(sprite, /syncPosFromWindow/);
    assert.match(sprite, /S\.placePetWindow\(\{/);
    assert.match(sprite, /this\.margin = place\.margins/);
    assert.match(sprite, /this\.applyWindowOffset\(\)/);
    assert.match(sprite, /this\.el\.style\.left = this\.margin\.l \+ 'px'/);
    assert.match(sprite, /this\.el\.style\.top = this\.margin\.t \+ 'px'/);
  });

  test('四个余量随 setBounds 上报，主进程据此算命中区', () => {
    assert.match(sprite, /toScreen\(this\.margin\.r\),\s*toScreen\(this\.margin\.b\),/);
    assert.match(preload, /marginL, marginT, marginR, marginB/);
    assert.match(main, /const mr = Number\(bounds\?\.marginR\)/);
    assert.match(main, /const mb = Number\(bounds\?\.marginB\)/);
    assert.match(main, /r: Number\.isFinite\(mr\) \? mr : ml/);
  });

  test('拖拽基准用指针屏幕坐标，窗口被夹住也不影响跟手', () => {
    assert.match(sprite, /sx: toLocal\(e\.screenX\)/);
    assert.match(sprite, /const dx = toLocal\(e\.screenX\) - d\.sx/);
    assert.match(sprite, /dragTarget = \{ x: d\.petX \+ dx, y: d\.petY \+ dy \}/);
  });
});

describe('main.js 接线守卫 —— 兜底轮询必须真的用上全局坐标', () => {
  const main = readSource('../../runtime/electron-helper/main.js');

  test('启动/停止 xinput 监听', () => {
    assert.match(main, /require\('\.\/linux-pointer\.js'\)/);
    assert.match(main, /ensureLinuxPointer\(\)/);
    assert.match(main, /startLinuxPointerWatcher\(/);
    assert.match(main, /linuxPointer\?\.stop\(\)/);
  });

  test('轮询优先读 xinput，取不到才回落 Electron 原生取值', () => {
    assert.match(main, /const point = linuxPointer\?\.getPoint\(\) \?\? screen\.getCursorScreenPoint\(\)/);
  });

  test('窗口仍默认整窗穿透（兜底通道是“按位置翻转”，不是把整窗变成可交互）', () => {
    assert.match(main, /setWindowIgnore\(win, true\)/);
  });
});

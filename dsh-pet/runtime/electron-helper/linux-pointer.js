/**
 * dsh-pet desktop helper —— Linux/X11 全局光标位置（点击穿透兜底通道的输入源）。
 *
 * 背景：窗口默认整窗点击穿透（`setIgnoreMouseEvents(true, { forward: true })`）。Windows/macOS 上
 * `forward` 会把鼠标移动转发进渲染端，渲染端据此翻转可交互；**Linux 上 Electron 不实现这条转发**
 * （实测：X11 输入形状被设成 1×1 后，真实鼠标在窗口内也不产生任何 DOM pointermove）。更糟的是
 * `screen.getCursorScreenPoint()` 在 X11 下读到的是 Chromium 缓存的旧值，只有应用自己收到鼠标事件
 * 才会刷新——穿透窗口永远收不到事件，于是兜底轮询也永远停在旧坐标，宠物既不能 hover 也不能拖。
 *
 * 本模块用 `xinput test-xi2 --root` 订阅 XI2 的全局指针事件：它是 X server 级别的原始事件流，
 * 不受窗口输入形状/焦点/遮挡影响，正好补上 Linux 缺失的那只“全局眼睛”。主进程每 60ms 读一次
 * `getPoint()`，其余判定仍走 pointer-target.js 的纯函数（与渲染端那条通道共用同一套几何）。
 *
 * 依赖与降级：
 *  - `xinput` 是 xinput 包提供的标准 X11 工具，GNOME/KDE 常见安装；找不到时本模块返回 null，
 *    主进程回落到原来的 `screen.getCursorScreenPoint()`（行为与改造前一致，不会崩）。
 *  - `stdbuf -oL` 强制行缓冲：xinput 的 stdout 接管道时默认块缓冲，不包一层会攒满 4KB 才吐，
 *    鼠标已经停下来了坐标才到。stdbuf 也不存在时直接跑 xinput，最多延迟一次缓冲。
 *  - 仅 X11：没有 `DISPLAY` 时不启动（Wayland 原生会话下 xinput 看不到原生窗口的指针）。
 *
 * 坐标：XI2 的 root 坐标是**物理像素**；主进程的 `win.getBounds()` / `screen.getCursorScreenPoint()`
 * 是 DIP。`scale` 由主进程按当前 `--force-device-scale-factor` 传入，本模块只做除法与取整。
 *
 * 纯解析函数单独导出，供 node:test 直接加载（helper 是手写 JS，不经过 tsc）。
 */

'use strict';

const { spawn, spawnSync } = require('node:child_process');

/** xinput 输出里的 root 坐标行（`root x/y:` 是焦点事件，不匹配） */
const ROOT_LINE_RE = /^\s*root:\s*(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\s*$/;

/**
 * 解析一行 `xinput test-xi2 --root` 输出。
 *
 * @param {string} line
 * @returns {{x:number,y:number}|null} 物理像素坐标；不是 root 行时返回 null
 */
function parseXi2RootLine(line) {
  const m = ROOT_LINE_RE.exec(String(line ?? ''));
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * 流式解析器：喂入任意行，遇到 root 坐标行就回调。
 *
 * `throttleMs` 默认 15ms（≈66Hz）：高刷鼠标一秒能产生上千行，主进程 60ms 才读一次，没必要为
 * 每一行都回调；只保留“最新位置”这一件事。测试里传 0 可关闭节流。
 *
 * @param {{onPoint:(p:{x:number,y:number})=>void, scale?:number, throttleMs?:number, now?:()=>number}} options
 * @returns {(line:string)=>void}
 */
function createXi2Parser(options = {}) {
  const onPoint = options.onPoint;
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 1;
  const throttleMs = Number.isFinite(options.throttleMs) ? Number(options.throttleMs) : 15;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let lastAt = -Infinity;
  return (line) => {
    const p = parseXi2RootLine(line);
    if (!p) return;
    const t = now();
    if (t - lastAt < throttleMs) return;
    lastAt = t;
    onPoint?.({ x: Math.round(p.x / scale), y: Math.round(p.y / scale) });
  };
}

/** 命令是否存在（同步、只跑一次；避免每次启动都反复 spawn 失败的子进程） */
function commandExists(command, args) {
  try {
    const r = spawnSync(command, args, { stdio: 'ignore', timeout: 2000, windowsHide: true });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 启动 Linux 全局光标监听。
 *
 * 返回对象：
 *  - `getPoint()`：最近一次解析到的 DIP 坐标；还没收到事件时返回 undefined（调用方回落）；
 *  - `stop()`：停止子进程并取消重启（app 退出时调用）。
 *
 * 非 Linux / 无 DISPLAY / 无 xinput 时返回 null。
 *
 * @param {{platform?:string, display?:string, scale?:number, disabled?:boolean,
 *          onPoint?:(p:{x:number,y:number})=>void, onError?:(e:Error)=>void}} [options]
 */
function startLinuxPointerWatcher(options = {}) {
  const platform = options.platform ?? process.platform;
  const display = options.display ?? process.env.DISPLAY;
  if (platform !== 'linux' || options.disabled || !display) return null;
  if (!commandExists('xinput', ['--version'])) return null;

  const useStdbuf = commandExists('stdbuf', ['--version']);
  const command = useStdbuf ? 'stdbuf' : 'xinput';
  const args = useStdbuf ? ['-oL', 'xinput', 'test-xi2', '--root'] : ['test-xi2', '--root'];

  let latest;
  let child;
  let restartTimer;
  let stopped = false;
  let restartDelay = 1000;
  let warned = false;

  // 收到坐标 = 通道健康：把退避重置回 1s。高刷鼠标一秒上千行，主进程 60ms 才读一次，
  // 所以解析器内部按 15ms 节流，只保留最新位置。
  const feed = createXi2Parser({
    scale: options.scale,
    onPoint: (p) => {
      latest = p;
      restartDelay = 1000;
      options.onPoint?.(p);
    },
  });

  const warnOnce = (error) => {
    if (warned) return;
    warned = true;
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  const start = () => {
    if (stopped) return;
    let proc;
    try {
      proc = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      warnOnce(error);
      return;
    }
    child = proc;
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        feed(line);
      }
    });
    // stderr 只在首次失败时转成一条警告；正常运行 xinput 不写 stderr，避免刷屏
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) warnOnce(new Error(text.split('\n')[0]));
    });
    proc.once('error', (error) => {
      if (child === proc) child = undefined;
      warnOnce(error);
    });
    proc.once('exit', (code, signal) => {
      if (child === proc) child = undefined;
      if (stopped) return;
      // X server 重启/临时错误：退避重启；成功收到坐标后把退避重置回 1s
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        start();
      }, restartDelay);
      restartTimer.unref?.();
      restartDelay = Math.min(restartDelay * 2, 30000);
      if (!warned && code !== 0) {
        warnOnce(new Error(`xinput exited (code=${String(code)}, signal=${String(signal)})`));
      }
    });
  };

  start();

  return {
    getPoint: () => latest,
    stop: () => {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = undefined;
      if (child) {
        child.kill('SIGTERM');
        child = undefined;
      }
    },
  };
}

module.exports = {
  parseXi2RootLine,
  createXi2Parser,
  startLinuxPointerWatcher,
};

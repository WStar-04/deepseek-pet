/**
 * 外部工作状态端点（`POST /dsh-pet-7340/external/work-status`）的路由级回归。
 *
 * 背景：独立模式没有 DSH 的 `session/event`，OpenCode / Claude Code / Codex 也不会发 DSH 事件，
 * 所以需要一个稳定的外部写入口，把状态交给现有的 WorkStatusStore（而不是让适配层自己拼动画）。
 *
 * 这里只钉 HTTP 契约与多会话聚合：
 *   - 合法状态写入 S，任务文案随状态写入；
 *   - `state: null` 清掉该会话，其他会话仍在时展示优先级更高的那个；
 *   - 非法 JSON / 非法状态 / 错误方法显式失败，不静默；
 *   - 不给 task 时清掉旧文案，避免上一轮任务粘在气泡上。
 *
 * 跑法：node --experimental-strip-types --import ./scripts/test-register.mjs --test src/host/external-work-status.test.ts
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';

import { apply } from './index.ts';

type Result = { status: number; body: string };
type Snapshot = { state: string | null; task: string | null };

let dir = '';
let savedHome: string | undefined;
let savedElectron: string | undefined;
const disposers: Array<() => void> = [];

/** 最小响应桩：writeHead 记状态码，Writable 收集 body */
class FakeRes extends Writable {
  declare status: number;
  declare chunks: Buffer[];
  constructor() {
    super();
    this.status = 0;
    this.chunks = [];
  }
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
}

let call: (url: string, method?: string, body?: string) => Promise<Result> = () =>
  Promise.reject(new Error('未初始化'));

/** 读 S 里的工作状态叶子（同时验证"端点 → store → /state"整条链路） */
async function snapshot(): Promise<{ counter: number; data: Snapshot | null }> {
  const r = await call('/dsh-pet-7340/state');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body) as {
    sections: { workStatus: { counter: number; data: Snapshot | null } };
  };
  return body.sections.workStatus;
}

/** POST 一个外部状态，返回原始结果 */
function post(payload: unknown): Promise<Result> {
  return call('/dsh-pet-7340/external/work-status', 'POST', JSON.stringify(payload));
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-external-work-status-'));
  savedHome = process.env.DSH_HOME;
  savedElectron = process.env.DSH_PET_ELECTRON_PATH;
  process.env.DSH_HOME = join(dir, 'home');
  // 命中一个已存在的文件：桌面 Helper 不会真的下载/拉起
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;

  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const noop = (): void => {};
  apply({
    effect: (fn: () => unknown) => {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose as () => void);
        return dispose;
      } catch {
        /* 源码形态下内置配置不可达，refreshDesktop 会抛给调用方——吞掉，不影响路由注册 */
      }
    },
    on: () => noop,
    webServer: { register: (spec: { handler: typeof handler }) => ((handler = spec.handler), noop) },
    commands: { register: () => noop },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    agentDefaultModel: { currentSelection: () => undefined },
    credentials: { resolve: async () => undefined },
  });
  assert.ok(handler, 'apply() 应注册 /dsh-pet-7340 prefix handler');

  call = (url, method = 'GET', body) =>
    new Promise<Result>((done) => {
      const res = new FakeRes();
      res.on('finish', () => done({ status: res.status, body: Buffer.concat(res.chunks).toString('utf8') }));
      void handler?.(
        {
          method,
          url,
          on: (event: string, cb: (chunk?: Buffer) => void) => {
            if (event === 'data' && body !== undefined) queueMicrotask(() => cb(Buffer.from(body, 'utf8')));
            if (event === 'end') queueMicrotask(() => cb());
            return undefined;
          },
        },
        res,
      );
    });
});

after(() => {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose();
    } catch {
      /* 释放失败不影响其余清理 */
    }
  }
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (savedElectron === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
  else process.env.DSH_PET_ELECTRON_PATH = savedElectron;
  rmSync(dir, { recursive: true, force: true });
});

describe('/external/work-status —— 外部宿主工作状态入口', () => {
  test('合法状态 + task 写入 S，counter 推进', async () => {
    const r = await post({ state: 'working', task: '修复登录逻辑', session: 'opencode:a' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true });

    const leaf = await snapshot();
    assert.ok(leaf.counter > 0, '写入必须推进 counter，否则前端不会渲染');
    assert.deepEqual(leaf.data, { state: 'working', task: '修复登录逻辑' });
  });

  test('非 POST → 405（只写动作端点）', async () => {
    const r = await call('/dsh-pet-7340/external/work-status');
    assert.equal(r.status, 405);
  });

  test('非法 JSON / 非对象 / 缺 state / 非法 state → 400，且不写 S', async () => {
    const before = await snapshot();
    for (const body of [
      '{ 不是 json',
      '[]',
      'null',
      '{}',
      JSON.stringify({ state: 'busy' }),
      JSON.stringify({ state: 123 }),
      JSON.stringify({ state: true }),
      JSON.stringify({ state: 'working', session: '' }),
      JSON.stringify({ state: 'working', session: 42 }),
      JSON.stringify({ state: 'working', task: 42 }),
    ]) {
      const r = await call('/dsh-pet-7340/external/work-status', 'POST', body);
      assert.equal(r.status, 400, body);
    }
    assert.deepEqual((await snapshot()).data, before.data, '非法请求不得改动工作状态');
  });

  test('state:null 清掉该会话，回到空闲', async () => {
    await post({ state: 'working', session: 'opencode:a' });
    const r = await post({ state: null, session: 'opencode:a' });
    assert.equal(r.status, 200);
    assert.deepEqual((await snapshot()).data, { state: null, task: null });
  });

  test('session 由服务端统一加 external: 前缀，调用方不能拿它清掉内部 key', async () => {
    await post({ state: 'working', session: 'opencode:ns' });
    // 调用方自己带 external: 会被再套一层 → 清不到刚才的条目
    await post({ state: null, session: 'external:opencode:ns' });
    assert.equal((await snapshot()).data?.state, 'working');

    await post({ state: null, session: 'opencode:ns' });
    assert.deepEqual((await snapshot()).data, { state: null, task: null });
  });

  test('多个会话按优先级聚合：waiting 压过 working，清掉 waiting 后回到 working', async () => {
    await post({ state: 'working', task: '会话 A', session: 'opencode:a' });
    await post({ state: 'waiting', task: '会话 B', session: 'opencode:b' });

    let leaf = await snapshot();
    assert.deepEqual(leaf.data, { state: 'waiting', task: '会话 B' }, 'waiting 优先级高于 working');

    await post({ state: null, session: 'opencode:b' });
    leaf = await snapshot();
    assert.deepEqual(leaf.data, { state: 'working', task: '会话 A' }, '清掉 B 后应回到 A 的状态');

    await post({ state: null, session: 'opencode:a' });
    assert.deepEqual((await snapshot()).data, { state: null, task: null });
  });

  test('不给 task 时清掉旧文案，不把上一轮任务粘在气泡上', async () => {
    await post({ state: 'working', task: '旧任务', session: 'opencode:a' });
    await post({ state: 'result', session: 'opencode:a' });
    assert.deepEqual((await snapshot()).data, { state: 'result', task: null });
    await post({ state: null, session: 'opencode:a' });
  });

  test('六个合法状态都能被接受', async () => {
    for (const state of ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const) {
      const r = await post({ state, session: 'opencode:all' });
      assert.equal(r.status, 200, state);
      assert.equal((await snapshot()).data?.state, state, state);
    }
    await post({ state: null, session: 'opencode:all' });
  });

  test('success / error 终态 60s 后自动清理（与 DSH 会话同一套生命周期）', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => t.mock.timers.reset());

    await post({ state: 'success', session: 'opencode:term' });
    assert.equal((await snapshot()).data?.state, 'success');

    t.mock.timers.tick(60 * 1000);
    assert.deepEqual((await snapshot()).data, { state: null, task: null });
  });

  test('终态后回到非终态 → 取消那次清理，不会到点把进行中的状态清掉', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => t.mock.timers.reset());

    await post({ state: 'success', session: 'opencode:term2' });
    await post({ state: 'working', session: 'opencode:term2' });
    t.mock.timers.tick(60 * 1000);

    assert.deepEqual((await snapshot()).data, { state: 'working', task: null });
    await post({ state: null, session: 'opencode:term2' });
  });
});

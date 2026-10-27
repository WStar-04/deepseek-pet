/**
 * OpenCode 适配层（仓库根 `.opencode/plugins/dsh-pet/`）的纯逻辑回归。
 *
 * 适配层只有两件事值得钉：
 *   ① OpenCode 事件名 → 六档工作状态（映射错了宠物就会在错误时机表演）；
 *   ② 上报 HTTP 的形状与失败吞掉（适配层绝不能因为桌宠没开就打断 OpenCode 的事件流）。
 *
 * 这里直接 import `.opencode` 下的实现（与 OpenCode 运行时同一份文件），避免复制一份映射后走样。
 * 跑法：node --experimental-strip-types --import ./scripts/test-register.mjs --test src/opencode/bridge.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReporter,
  mapOpenCodeEvent,
  sessionIdOf,
  WORK_STATUS_URL_PATH,
} from '../../../.opencode/plugins/dsh-pet/bridge.ts';

describe('mapOpenCodeEvent —— OpenCode 事件到工作状态档位', () => {
  test('执行/步骤开始 → thinking', () => {
    assert.equal(mapOpenCodeEvent('session.execution.started'), 'thinking');
    assert.equal(mapOpenCodeEvent('session.step.started'), 'thinking');
  });

  test('工具调用 → working，成功 → result，失败 → error', () => {
    assert.equal(mapOpenCodeEvent('session.tool.called'), 'working');
    assert.equal(mapOpenCodeEvent('session.tool.success'), 'result');
    assert.equal(mapOpenCodeEvent('session.tool.failed'), 'error');
  });

  test('权限询问 → waiting', () => {
    assert.equal(mapOpenCodeEvent('permission.asked'), 'waiting');
  });

  test('执行成功 → success，执行失败 → error，中断 → null（清空）', () => {
    assert.equal(mapOpenCodeEvent('session.execution.succeeded'), 'success');
    assert.equal(mapOpenCodeEvent('session.execution.failed'), 'error');
    assert.equal(mapOpenCodeEvent('session.execution.interrupted'), null);
  });

  test('不关心的事件 → undefined（适配层跳过，不写状态）', () => {
    assert.equal(mapOpenCodeEvent('session.idle'), undefined);
    assert.equal(mapOpenCodeEvent('session.tool.progress'), undefined);
    assert.equal(mapOpenCodeEvent(undefined), undefined);
    assert.equal(mapOpenCodeEvent(42), undefined);
  });
});

describe('sessionIdOf —— 从事件里取 OpenCode 会话 id', () => {
  test('V2 事件：data.sessionID', () => {
    assert.equal(sessionIdOf({ type: 'x', data: { sessionID: 'ses_123' } }), 'ses_123');
  });

  test('兼容形态：data.session.id / 顶层 sessionID', () => {
    assert.equal(sessionIdOf({ data: { session: { id: 'ses_456' } } }), 'ses_456');
    assert.equal(sessionIdOf({ sessionID: 'ses_789' }), 'ses_789');
  });

  test('缺失 / 非字符串 / 空白 → null（这条事件直接跳过）', () => {
    assert.equal(sessionIdOf({}), null);
    assert.equal(sessionIdOf({ data: { sessionID: 123 } }), null);
    assert.equal(sessionIdOf({ data: { sessionID: '   ' } }), null);
    assert.equal(sessionIdOf(null), null);
  });
});

describe('createReporter —— 上报失败绝不抛给 OpenCode', () => {
  test('POST 到固定端点，session 带 opencode: 前缀，可清空', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const reporter = createReporter({
      baseUrl: 'http://127.0.0.1:3999/',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return { ok: true } as Response;
      },
    });

    assert.equal(await reporter.report('ses_123', 'working'), true);
    assert.equal(await reporter.report('ses_123', null), true);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://127.0.0.1:3999' + WORK_STATUS_URL_PATH);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      state: 'working',
      session: 'opencode:ses_123',
    });
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
      state: null,
      session: 'opencode:ses_123',
    });
  });

  test('HTTP 非 2xx / 网络错误 → false，不抛', async () => {
    const bad = createReporter({
      baseUrl: 'http://127.0.0.1:3999',
      fetchImpl: async () => ({ ok: false, status: 500 }) as Response,
    });
    assert.equal(await bad.report('ses_a', 'working'), false);

    const down = createReporter({
      baseUrl: 'http://127.0.0.1:3999',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(await down.report('ses_a', 'working'), false);
  });

  test('未配置地址 → 默认 127.0.0.1:3080', async () => {
    let seen = '';
    const reporter = createReporter({
      fetchImpl: async (url) => {
        seen = String(url);
        return { ok: true } as Response;
      },
    });
    await reporter.report('ses_default', 'thinking');
    assert.equal(seen, 'http://127.0.0.1:3080' + WORK_STATUS_URL_PATH);
  });
});

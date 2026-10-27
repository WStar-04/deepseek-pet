/**
 * dsh-pet ← OpenCode 插件（OpenCode V2）。
 *
 * 作用：订阅 OpenCode 的公共事件流，把会话活动映射成桌宠的六档工作状态，POST 到
 * dsh-pet 的 `/dsh-pet-7340/external/work-status`。桌宠的优先级聚合、气泡、终态清理都在宿主侧，
 * 本插件只做"翻译 + 搬运"。
 *
 * 使用前提：
 *   1. dsh-pet 已打上外部工作状态端点（本仓库源码已包含；发布版 npm 包若还没有，需要本地构建/打补丁）；
 *   2. 独立模式在跑：`dsh-pet-standalone --port 3080`；
 *   3. 某只宠物配置了 `workStatusEnabled: true`（否则桌宠不消费工作状态）。
 *
 * 地址：默认 `http://127.0.0.1:3080`。端口被占用时独立模式会顺延，或用
 * `DSH_PET_URL=http://127.0.0.1:3100` / `opencode.jsonc` 的插件 options.url 指定。
 */
import { Plugin } from '@opencode/plugin';

import { createReporter, mapOpenCodeEvent, sessionIdOf } from './bridge';

export default Plugin.define({
  id: 'dsh-pet',
  setup(ctx) {
    const options = (ctx.options ?? {}) as Record<string, unknown>;
    const envUrl = typeof process === 'undefined' ? undefined : process.env.DSH_PET_URL;
    const reporter = createReporter({ baseUrl: options.url ?? envUrl });

    const controller = new AbortController();
    // 正常卸载时把这些会话清掉，避免桌宠停在 working / thinking 不再下来。
    // 硬杀进程不会走 cleanup，残留状态需要重启独立模式或手动 POST state:null。
    const sessions = new Set<string>();

    const report = (sessionID: string, state: ReturnType<typeof mapOpenCodeEvent>): void => {
      if (state === undefined) return;
      sessions.add(sessionID);
      void reporter.report(sessionID, state);
    };

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (event as { type?: unknown } | null)?.type;
          const state = mapOpenCodeEvent(type);
          if (state === undefined) continue;
          const sessionID = sessionIdOf(event);
          if (sessionID === null) continue;
          report(sessionID, state);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('[dsh-pet] OpenCode 事件流中断，工作状态联动已停止：', error);
        }
      }
    })();

    return async () => {
      controller.abort();
      await Promise.all([...sessions].map((sessionID) => reporter.report(sessionID, null)));
    };
  },
});

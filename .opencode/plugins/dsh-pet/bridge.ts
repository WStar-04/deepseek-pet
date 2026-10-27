/**
 * dsh-pet ← OpenCode 适配层的纯逻辑（事件映射 + 上报）。
 *
 * 背景：dsh-pet 的 workStatus 原本只监听 DSH 的 `session/event`；OpenCode 不是 DSH 会话，
 * 所以由本插件订阅 OpenCode 的公共事件流，映射成六档状态后 POST 到
 * `/dsh-pet-7340/external/work-status`。宿主侧复用同一个 WorkStatusStore（优先级聚合、
 * 终态清理、任务文案、前端渲染全都不变），适配层不自己拼动画或气泡。
 *
 * 这里不 import `@opencode/plugin`：保持纯函数可脱离 OpenCode 运行时单测，
 * `index.ts` 只负责生命周期接线。
 */

/** 与宿主 `HostWorkStatusState` / 配置 `events.workStatus` 数组索引严格一致 */
export type PetState = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error';

/** 独立模式默认端口；DSH 内运行时端口可能不同，用 DSH_PET_URL 或插件 options.url 覆盖 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';

/** 宿主新增的外部工作状态入口（与 openapi.yaml 一致） */
export const WORK_STATUS_URL_PATH = '/dsh-pet-7340/external/work-status';

/**
 * OpenCode 事件名 → 宠物档位。
 *   - undefined = 不关心，跳过；
 *   - null = 清空该会话（回合被中断，不能残留上一档）。
 */
export function mapOpenCodeEvent(type: unknown): PetState | null | undefined {
  switch (type) {
    case 'session.execution.started':
    case 'session.step.started':
      return 'thinking';
    case 'session.tool.called':
      return 'working';
    case 'session.tool.success':
      return 'result';
    case 'session.tool.failed':
    case 'session.step.failed':
    case 'session.execution.failed':
      return 'error';
    case 'permission.asked':
      return 'waiting';
    case 'session.execution.succeeded':
      return 'success';
    case 'session.execution.interrupted':
      return null;
    default:
      return undefined;
  }
}

/**
 * 从 OpenCode 事件里取会话 id。
 * V2 的公共事件是 `{ type, data: { sessionID, ... } }`；另外兼容 `data.session.id` 与顶层字段，
 * 避免 OpenCode 小版本调整形状时整个适配层静默失效。
 */
export function sessionIdOf(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as {
    data?: { sessionID?: unknown; session?: { id?: unknown } };
    sessionID?: unknown;
  };
  const raw = e.data?.sessionID ?? e.data?.session?.id ?? e.sessionID;
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return id === '' ? null : id;
}

/** 上报器（只做 HTTP，不抛异常） */
export interface Reporter {
  /** 上报一次状态；返回 false = 桌宠没开 / 网络失败 / 超时，调用方不需要处理 */
  report(sessionID: string, state: PetState | null): Promise<boolean>;
}

export interface ReporterOptions {
  /** `http://127.0.0.1:3080/` 或带路径的完整基址；缺省走 DEFAULT_BASE_URL */
  baseUrl?: unknown;
  /** 测试注入；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 单次上报超时；桌宠不在时不能把 OpenCode 的事件循环拖住 */
  timeoutMs?: number;
}

/** 统一基址：去空白、去尾部斜杠；空值回落默认端口 */
export function normalizeBaseUrl(raw: unknown): string {
  const value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_BASE_URL;
  return value.replace(/\/+$/, '');
}

export function createReporter(options: ReporterOptions = {}): Reporter {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 800;

  return {
    async report(sessionID, state) {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      if (typeof fetchImpl !== 'function') return false;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}${WORK_STATUS_URL_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state, session: `opencode:${sessionID}` }),
          signal: controller.signal,
        });
        return res.ok;
      } catch {
        // 桌宠没启动 / 端口换过 / 超时：静默失败。适配层绝不能因为桌宠而打断 OpenCode。
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

# dsh-pet × OpenCode 适配器

订阅 OpenCode V2 的公共事件流，把会话活动映射成桌宠的六档工作状态。桌宠侧复用
`/dsh-pet-7340/external/work-status` 和现有的 `WorkStatusStore`，所以优先级聚合、气泡、
终态清理、前端渲染都与 DSH 原生会话完全一致。

## 功能简述

- **只做工作状态联动**：把 OpenCode 的思考 / 调工具 / 等权限 / 完成 / 报错翻译成桌宠的六档动画，不生成碎碎念或对话，也不控制动画池
- **与 DSH 同一条展示路径**：状态写入同一个 `WorkStatusStore`，多个会话按优先级聚合，浏览器与桌面端渲染完全复用
- **多会话隔离**：每个 OpenCode 会话单独记状态；中断或结束只清自己那条，不会误伤其他会话
- **失败不打扰**：桌宠没启动、端口不对或请求超时都静默忽略，绝不打断 OpenCode 的事件流
- **零模型成本**：只读事件、上报状态，不调用任何 LLM

## 部署

> 完整部署步骤（含独立模式启动、配置与验证）见 [仓库根 README 的「联动 OpenCode」](../../../README.md#opencode) 一节；下面是最短路径。

1. **宿主侧已包含外部状态端点**：本仓库源码已实现；如果你是 `npm i dsh-pet` 安装的发布版，
   而该版本还没有 `/external/work-status`，需要从本仓库本地构建，或用 `patch-package` 给发布包打补丁。
2. **独立模式在跑**（不需要安装/启动 DSH）：

   ```sh
   cd dsh-pet
   npm install
   npm run build
   node lib/standalone.js --port 3080
   ```

   也可以全局安装后直接跑：

   ```sh
   npm i -g dsh-pet
   dsh-pet-standalone --port 3080
   ```

3. **至少一只宠物开启了工作状态**：配置里 `pets[].workStatusEnabled: true`，且 `display`
   含 `desktop` 或 `both`（独立模式没有浏览器 overlay）。

### 启用插件

OpenCode 会自动加载项目里的 `.opencode/plugins/`。本目录已经放好，重启 OpenCode 或执行
`opencode reload` 即可。

默认地址是 `http://127.0.0.1:3080`。如果独立模式因为端口占用顺延，或你想连另一台/另一个端口：

```sh
DSH_PET_URL=http://127.0.0.1:3100 opencode
```

桌宠也可以跑在 DSH 内（`dsh web`），把 `DSH_PET_URL` 指向 DSH Web 服务地址即可；独立模式只是不需要 DSH 的最短路径。

也可以在 `opencode.jsonc` 里用插件 options（只有**手动**把插件加到 `plugins` 时才需要，
自动加载时不要重复添加）：

```jsonc
{
  "plugins": [
    {
      "package": "./.opencode/plugins/dsh-pet",
      "options": { "url": "http://127.0.0.1:3100" },
    },
  ],
}
```

要在所有项目里使用，把整个 `.opencode/plugins/dsh-pet/` 目录复制到 `~/.config/opencode/plugins/` 下
（Windows：`%USERPROFILE%\.config\opencode\plugins\`，即 `~/.config/opencode/plugins/dsh-pet/`），并在需要时用上面的 `DSH_PET_URL` 指定端口。

## 事件映射

| OpenCode 事件                                        | 桌宠档位                           |
| ---------------------------------------------------- | ---------------------------------- |
| `session.execution.started` / `session.step.started` | `thinking`                         |
| `session.tool.called`                                | `working`                          |
| `session.tool.success`                               | `result`                           |
| `session.tool.failed` / `session.step.failed`        | `error`                            |
| `permission.asked`                                   | `waiting`                          |
| `session.execution.succeeded`                        | `success`                          |
| `session.execution.failed`                           | `error`                            |
| `session.execution.interrupted`                      | 清空该会话（回空闲或其他活跃会话） |
| 其他事件（含 `session.idle`）                        | 忽略                               |

会话 key 统一写成 `opencode:<OpenCode sessionID>`，宿主再加 `external:` 前缀，
所以不会和 DSH 自己的会话条目撞车。

## 验证

```sh
# OpenCode 是否加载了本插件
opencode plugin list

# 桌宠服务在跑吗
curl -s http://127.0.0.1:3080/health

# 手动写一个状态（session 由宿主加 external: 前缀）
curl -s -X POST http://127.0.0.1:3080/dsh-pet-7340/external/work-status \
  -H 'content-type: application/json' \
  -d '{"state":"working","session":"manual:demo"}'

# 看统一状态
curl -s http://127.0.0.1:3080/dsh-pet-7340/state | jq '.sections.workStatus'

# 清掉
curl -s -X POST http://127.0.0.1:3080/dsh-pet-7340/external/work-status \
  -H 'content-type: application/json' \
  -d '{"state":null,"session":"manual:demo"}'
```

## 边界

- **只接工作状态**：不生成碎碎念、不弹 `broadcast` 气泡、不控制动画池；这些能力仍由 DSH
  或在独立模式下明确不可用。
- **任务文案**：OpenCode 事件里没有 DSH `todo/write` 那种任务清单，所以本适配器不写 `task`，
  气泡会显示配置里的 `workStatusTexts` 档位文案。
- **硬杀进程**：正常卸载会清掉本插件见过的所有会话；`kill -9` 不走 cleanup，非终态可能残留。
  重启独立模式即可清空（状态全在内存里）。
- **只在本机**：端点无鉴权且只监听 `127.0.0.1`，不要把端口转发到公网。

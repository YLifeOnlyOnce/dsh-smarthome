<p align="center">
  <img src="docs/assets/banner.svg" alt="dsh-smarthome" width="820">
</p>

<p align="center">
  <b>给 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> agent 的 Home Assistant 控制插件。</b><br>
  读取实体状态 · 查询历史 · 调用服务——所有改变状态的调用都经过人工审批闸门。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-ecosystem-4d7cfe" alt="dsh-plugin"></a> ·
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a> ·
  <a href="https://github.com/YLifeOnlyOnce/dsh-smarthome/actions/workflows/ci.yml"><img src="https://github.com/YLifeOnlyOnce/dsh-smarthome/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">除 harness 本身外零运行时依赖。使用 Home Assistant 内置 REST API——不需要 MQTT、WebSocket 或额外守护进程。</p>

---

## ✨ 效果预览

点击图片可打开在线演示 —— [`docs/demo.html`](docs/demo.html) 会模拟完整的 DSH 对话，右侧实时控制台直连自带的 HA 模拟器（不需要真实 Home Assistant）。

| ① 提问 | ② 审批闸门 | ③ 完成——状态真的变了 |
|---|---|---|
| <img src="docs/assets/demo-start.png" width="380" alt="开始"> | <img src="docs/assets/demo-approval.png" width="380" alt="审批"> | <img src="docs/assets/demo-final.png" width="380" alt="完成"> |
| agent 用 `ha_list_entities` 列出你的灯。 | `ha_call_service` 暂停，弹出人工审批框。 | 批准后 `ha_get_state` 确认灯已打开。 |

## 🎯 能做什么？

像跟管家说话一样指挥你的家——所有写操作都先经过人工审批。

| 你说 | 会发生什么 |
|---|---|
| 「检查一下全屋，哪些设备还开着？」 | agent 用 `ha_list_entities` / `ha_get_state` 扫描并汇总 |
| 「把卧室灯调到 200 亮度。」 | `ha_call_service` → **审批弹窗** → 执行 → 状态即时更新 |
| 「关掉客厅里所有的灯。」 | **区域定位**——一次调用控制整间房 |
| 「开启电影模式。」 | 场景联动：灯调暗、电视打开——一条命令多设备联动（`ha_events` 实时显示每个变化） |
| 「过去一小时家里发生了什么变化？」 | WebSocket **实时事件流** |
| 「客厅温度够吗？和卧室比一下。」 | `ha_get_state` / `ha_render_template` 查传感器、算模板 |
| 「我要出门了，把一切都关掉。」 | 一个场景（`scene.away`）或批量实体调用 |

## 💡 为什么好用？

- **一行安装**：`dsh plugin --profile web add dsh-smarthome`，装完直接说话
- **安全默认**：所有改变状态的调用都停在人工审批前；`allowedDomains` 域白名单是第二道保险——**agent 不经你同意永远碰不了你的家**
- **自然语言控制**：不用翻 App、不用记 API，一句「把灯调暗」就搞定
- **状态永远新鲜**：WebSocket 实时推送，agent 不会"以为"灯还开着
- **轻量**：零运行时依赖——纯 REST + Node 内置 WebSocket，没有 MQTT、没有额外守护进程
- **没有 Home Assistant 也能玩**：自带演示模拟器 + 交互演示页，5 分钟完整感受
- **工程化而非拼凑**：24 个测试（含完整**真实 agent-loop 端到端**）、严格 TypeScript、CI

## 🛠 功能

| 工具 | 说明 | 审批 |
|---|---|---|
| `ha_health` | 验证连接；返回实例名、版本、时区、WebSocket 状态 | 只读 |
| `ha_list_entities` | 列出实体，按 domain（`light`、`switch`、`sensor`…）和文本过滤 | 只读 |
| `ha_list_areas` | 通过 WebSocket 列出房间（区域），如 `living_room` | 只读 |
| `ha_get_state` | 单个实体的完整状态与属性 | 只读 |
| `ha_history` | 一段时间内的状态变化时间线 | 只读 |
| `ha_events` | WebSocket 缓冲的最近实时状态变化 | 只读 |
| `ha_list_scenes` | 列出一键场景（`cinema`、`goodnight`、`away`…） | 只读 |
| `ha_call_service` | 调用任意服务——按**实体**、按**区域**（整间房）、按**设备**、按**场景** | **需批准** |
| `ha_render_template` | 服务端渲染 Jinja2 模板 | **需批准** |

示例提示词：

> 「检查 Home Assistant 是否在线，然后列出客厅的灯。」
>
> 「把客厅灯调到 60% 亮度。」*（会触发审批请求）*
>
> 「给我看过去 24 小时锅炉开关的历史记录。」
>
> 「关掉卧室里所有的灯。」*（区域定位——一次调用，整间房）*
>
> 「开启电影模式。」*（场景联动——灯调暗、电视打开）*
>
> 「过去一小时家里发生了什么变化？」*（实时 `ha_events`）*

## 📦 安装

需要 **dsh ≥ 0.1.0-rc.6**（当前 npm latest）。

```sh
# 从 npm 安装（推荐，预构建产物）：
dsh plugin --profile web add dsh-smarthome

# 或从 GitHub 安装（源码安装，pnpm 会在安装时自动构建）：
# dsh plugin --profile web add github:YLifeOnlyOnce/dsh-smarthome
# 如果 pnpm 拒绝运行 git 依赖的 prepare 构建脚本，需要放行一次：
#   在 <profile>/pnpm-workspace.yaml 里加上，然后重新执行 add：
#     allowBuilds:
#       dsh-smarthome: true
```

安装后重启 `dsh --profile web`。可在 **Settings → Plugins** 管理。

## 🧪 没有 Home Assistant？先玩演示模式

仓库自带一个**假的 HA 模拟器**：一个会"动"的演示小家——调用服务真的会改变实体状态，适合在接真实硬件之前完整体验插件。

```sh
git clone https://github.com/YLifeOnlyOnce/dsh-smarthome
cd dsh-smarthome
pnpm install
pnpm demo:ha          # 在 http://127.0.0.1:8124 起一个假的 Home Assistant
```

另开一个终端，在 profile 的 `cordis.patch.yml` 里配置插件：

```yaml
- id: smarthome
  config:
    baseUrl: http://127.0.0.1:8124
    tokenEnv: HOME_ASSISTANT_TOKEN
```

然后启动 dsh 试试：

```sh
HOME_ASSISTANT_TOKEN=demo-token dsh --profile web
```

> 「检查 Home Assistant 是否在线，然后列出所有灯。」
>
> 「把卧室灯调到 200 亮度。」——会弹出审批请求；批准后 `ha_get_state` 会显示灯确实是 `on`，且 `brightness: 200`。
>
> 「关掉客厅里所有的灯。」——通过 WebSocket 区域注册表做区域定位。
>
> 「过去一分钟发生了什么变化？」——WebSocket 实时 `state_changed` 事件。

模拟器里的温度传感器每几秒漂移一次，所以 `ha_history` 和 `ha_events` 永远有新数据。任意 `Bearer` token 都行，`demo-token` 只是约定俗成。

**想完全不启动 dsh 就先看效果？** 用浏览器打开 [`docs/demo.html`](docs/demo.html)：它会回放一段模拟的 DSH 对话（工具卡片 + 审批弹窗），模拟器运行时右侧实时控制台还会直连它做真实调用。

可直接粘贴的配置（演示模式 / 真实 HA / 关闭审批）见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)。

## ⚙️ 配置

在 Home Assistant 中创建长期访问令牌：**个人资料 → 安全 → 长期访问令牌**。

在 profile 的 `cordis.patch.yml` 中覆盖插件配置（后层覆盖前层）：

```yaml
- id: smarthome
  config:
    baseUrl: http://192.168.1.10:8123   # 你的 Home Assistant 实例
    token: ''                           # 建议用 tokenEnv，不要把令牌写进配置
    tokenEnv: HOME_ASSISTANT_TOKEN      # 存放令牌的环境变量名
    timeoutMs: 15000
    requireApproval: true               # 改变状态的调用需要人工批准
    allowedDomains: []                  # 例如 ["light", "switch"]；留空 = 允许所有 domain
    maxHistoryEvents: 200
    wsEnabled: true                     # 实时事件 + 区域注册表（WebSocket）
    eventBufferSize: 50                 # ha_events 滚动缓冲大小
```

然后带上环境变量启动：

```sh
HOME_ASSISTANT_TOKEN=<token> dsh --profile web
```

`baseUrl` 默认为 `http://homeassistant.local:8123`（Home Assistant 标准 mDNS 地址）。未配置令牌时插件仍会加载——每次调用都会给出清晰的「未配置」错误，而不是让 harness 崩溃。

### 令牌如何解析

`tokenEnv` 是一个**凭证引用**，通过 harness 的[凭证接缝](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/credentials)解析：存在 `credentials` 服务时，从分层来源读取（进程环境 → `<cwd>/.env` → `$DSH_HOME/.env`），否则直接回退到 `process.env`。令牌**每次请求 / 每次连接都会重新解析**，轮换凭证无需重启立即生效。

## 🔒 安全说明

- Home Assistant 令牌可以控制实例里的**一切**——没有按实体授权的粒度。因此 `requireApproval` 默认为 `true`，`ha_call_service` / `ha_render_template` 永远走 harness 的审批接缝。
- `allowedDomains` 是第二道保险：设置后，其他 domain 的服务调用会被直接拒绝。
- 优先用 `tokenEnv` 而不是 `token`，避免密钥进 Git 提交。

## 🛠 开发

```sh
pnpm install
pnpm typecheck   # 针对已发布的 @deepseek-ai/* 类型做严格 TS 检查
pnpm build       # 打包 lib/（ESM + d.ts）
pnpm test        # 24 个测试：客户端 + 真实 ToolRuntime 集成 + 完整 agent-loop 端到端
node scripts/capture-demo.mjs   # 重新生成 README 截图
```

## 📋 兼容性

DeepSeek Harness 处于 developer preview，迭代很快。本插件已针对 npm 发布的 `@deepseek-ai/dsh@0.1.0-rc.6` 验证；如果 harness 更新导致不兼容，请提 issue。

## 📄 许可证

MIT

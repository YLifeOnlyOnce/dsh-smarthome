# dsh-smarthome

[English](README.md) · [dsh-plugin](https://github.com/topics/dsh-plugin) · MIT

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent 的 Home Assistant 控制插件。** 让 agent 读取实体状态、查询历史、调用服务（灯、开关、空调……）——所有改变状态的调用都经过人工审批闸门。

除 harness 本身外零运行时依赖。使用 Home Assistant 内置 REST API——不需要 MQTT、WebSocket 或额外守护进程。

## 功能

| 工具 | 说明 | 审批 |
|---|---|---|
| `ha_health` | 验证连接；返回实例名、版本、时区 | 只读 |
| `ha_list_entities` | 列出实体，按 domain（`light`、`switch`、`sensor`…）和文本过滤 | 只读 |
| `ha_get_state` | 单个实体的完整状态与属性 | 只读 |
| `ha_history` | 一段时间内的状态变化时间线 | 只读 |
| `ha_call_service` | 调用任意服务，如 `light.turn_on`、`climate.set_temperature` | **需批准** |
| `ha_render_template` | 服务端渲染 Jinja2 模板 | **需批准** |

示例提示词：

> 「检查 Home Assistant 是否在线，然后列出客厅的灯。」
>
> 「把客厅灯调到 60% 亮度。」*（会触发审批请求）*
>
> 「给我看过去 24 小时锅炉开关的历史记录。」

## 安装

需要 **dsh ≥ 0.1.0-rc.6**（当前 npm latest）。

```sh
# 从 GitHub 安装（源码安装，pnpm 会在安装时自动构建）：
dsh plugin --profile web add github:<你>/dsh-smarthome

# 如果 pnpm 拒绝运行 git 依赖的 prepare 构建脚本，需要放行一次：
#   在 <profile>/pnpm-workspace.yaml 里加上，然后重新执行 add：
#     allowBuilds:
#       dsh-smarthome: true

# 或从 npm 安装（发布后）：
# dsh plugin --profile web add dsh-smarthome
```

安装后重启 `dsh --profile web`。可在 **Settings → Plugins** 管理。

## 没有 Home Assistant？先玩演示模式

仓库自带一个**假的 HA 模拟器**：一个会"动"的演示小家——调用服务真的会改变实体状态，适合在接真实硬件之前完整体验插件。

```sh
git clone https://github.com/<你>/dsh-smarthome
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

模拟器里的温度传感器每几秒漂移一次，所以 `ha_history` 永远有新数据。任意 `Bearer` token 都行，`demo-token` 只是约定俗成。

## 配置

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
```

然后带上环境变量启动：

```sh
HOME_ASSISTANT_TOKEN=<token> dsh --profile web
```

`baseUrl` 默认为 `http://homeassistant.local:8123`（Home Assistant 标准 mDNS 地址）。未配置令牌时插件仍会加载——每次调用都会给出清晰的「未配置」错误，而不是让 harness 崩溃。

## 安全说明

- Home Assistant 令牌可以控制实例里的**一切**——没有按实体授权的粒度。因此 `requireApproval` 默认为 `true`，`ha_call_service` / `ha_render_template` 永远走 harness 的审批接缝。
- `allowedDomains` 是第二道保险：设置后，其他 domain 的服务调用会被直接拒绝。
- 优先用 `tokenEnv` 而不是 `token`，避免密钥进 Git 提交。

## 开发

```sh
pnpm install
pnpm typecheck   # 针对已发布的 @deepseek-ai/* 类型做严格 TS 检查
pnpm build       # 打包 lib/（ESM + d.ts）
pnpm test        # 客户端测试（内存中的 HA REST API mock）
```

## 兼容性

DeepSeek Harness 处于 developer preview，迭代很快。本插件已针对 npm 发布的 `@deepseek-ai/dsh@0.1.0-rc.6` 验证；如果 harness 更新导致不兼容，请提 issue。

## 许可证

MIT

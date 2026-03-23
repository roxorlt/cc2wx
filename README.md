# cc2wx

**Claude Code ↔ 微信桥接** — 用手机微信和本地 Claude Code 实时对话。

> **Experimental** — 本项目依赖 Claude Code Channels（research preview）和微信 ClawBot（灰度测试中），两者均为实验性功能，随时可能变更。

*Read this in [English](#english)*

## 工作原理

```mermaid
sequenceDiagram
    participant W as 手机微信
    participant API as iLink Bot API<br/>(微信官方服务)
    participant C as cc2wx<br/>(MCP Channel Server)
    participant CC as Claude Code CLI

    Note over W,CC: 首次登录
    C->>API: 获取登录二维码
    API-->>C: 返回 QR 码内容
    C-->>W: 终端显示二维码
    W->>API: 扫码确认授权
    API-->>C: 返回 bot_token 凭证
    Note over C: 凭证保存到本地<br/>后续自动复用

    Note over W,CC: 收消息
    W->>API: 发送消息
    C->>API: 长轮询拉取 (getUpdates)
    API-->>C: 返回新消息
    C->>CC: MCP channel notification
    Note over CC: Claude 处理消息

    Note over W,CC: 发回复
    CC->>C: 调用 weixin_reply 工具
    Note over C: 长文本自动分段
    C->>API: sendmessage
    API-->>W: 微信收到回复
```

cc2wx 是一个 MCP Channel Server，通过微信 [iLink Bot API](https://github.com/epiral/weixin-bot) 接收微信消息，再通过 Claude Code 的 [Channel 协议](https://code.claude.com/docs/en/channels) 实时推送给本地运行的 Claude Code 会话。Claude 的回复通过 `weixin_reply` 工具发回微信。

## 前提条件

- **Node.js** >= 18
- **Claude Code CLI** >= 2.1.80（需支持 `--channels`）
- **微信 ClawBot 灰度资格** — 打开微信 → 我 → 设置 → 插件，看是否有「爪爪机器人」。如果没有，说明你的微信号尚未被灰度到，暂时无法使用
- **macOS / Linux**（macOS 下自动使用 `caffeinate` 防休眠，Linux 直接运行）

## 快速开始

### 方式一：npx 一键运行（推荐）

```bash
npx cc2wx login    # 首次：扫码登录 → 自动启动 Claude Code
npx cc2wx start    # 后续：使用已保存凭证启动
```

### 方式二：从源码运行

```bash
git clone https://github.com/roxorlt/cc2wx.git
cd cc2wx
npm install
npm run login      # 首次登录
npm start          # 后续启动
```

### 登录流程

终端会显示二维码，用微信扫码确认授权。登录成功后自动启动 Claude Code。

凭证保存在 `~/.weixin-bot/credentials.json`，后续无需重复扫码。

### 启动后

在手机微信里给自己的微信号发消息，Claude Code 会实时收到并回复。

底层等价于：

```bash
caffeinate -i claude \
  --dangerously-load-development-channels server:cc2wx \
  --dangerously-skip-permissions \
  --effort max
```

## 安全须知

### `--dangerously-skip-permissions`

此参数**跳过所有权限确认**，意味着 Claude Code 可以不经确认地执行任意 Bash 命令、编辑文件等。微信消息会作为 prompt 输入，理论上存在 prompt injection 风险。

**建议措施：**

1. **设置白名单** — 只允许你自己的微信 userId 触发 Claude：

   ```bash
   CC2WX_ALLOWED_USERS=your_user_id npm start
   ```

   首次运行不设白名单，发一条消息后在终端日志中找到 `from=xxx` 获取你的 userId。

2. **不要在生产环境或包含敏感数据的目录下运行**

3. 如果不想跳过权限，可以从 `npm start` 中去掉该参数，改为手动确认每个操作

### `caffeinate -i`

`npm start` 和 `npm run login` 使用 `caffeinate -i` 阻止 macOS 空闲休眠（屏幕可以关闭），确保息屏后微信消息仍能送达。Claude Code 退出时 `caffeinate` 自动结束。

## 环境变量

| 变量 | 说明 |
|------|------|
| `CC2WX_ALLOWED_USERS` | 允许的微信 userId 白名单，逗号分隔。留空则接受所有消息（发现模式） |

## 命令

### npx 方式

| 命令 | 说明 |
|------|------|
| `npx cc2wx login` | 扫码登录 → 保存凭证 → 自动启动 Claude Code |
| `npx cc2wx start` | 使用已保存凭证启动 Claude Code（含防休眠） |
| `npx cc2wx serve` | 单独运行 MCP server（调试用，不启动 Claude） |

### 源码方式

| 命令 | 说明 |
|------|------|
| `npm run login` | 扫码登录 → 保存凭证 → 自动启动 Claude Code |
| `npm start` | 使用已保存凭证启动 Claude Code（含防休眠） |
| `npm run serve` | 单独运行 MCP server（调试用，不启动 Claude） |

## 特性

- 微信消息实时推送到 Claude Code 会话
- 长回复自动分段发送（每段 ≤ 2000 字，按段落拆分）
- 登录凭证本地持久化，无需重复扫码
- 息屏防休眠，合盖也能保持通信
- userId 白名单过滤

## 已知限制

- **ClawBot 灰度** — 微信 ClawBot 功能尚在灰度测试中，不是所有微信号都能用
- **Channels research preview** — Claude Code 的 Channel 功能也是实验性的
- **单 context_token 回复上限** — iLink API 每条收到的消息最多回复约 10 条，超长回复可能丢失尾段
- **仅文本** — 目前只支持文本消息，不支持图片/语音/文件
- **macOS / Linux** — macOS 自动 `caffeinate` 防休眠，Linux 直接运行（Windows 未测试）

## 致谢

- [weixin-ClawBot-API](https://github.com/SiverKing/weixin-ClawBot-API) — WeChat iLink Bot API 协议参考
- [weixin-bot](https://github.com/epiral/weixin-bot) — WeChat iLink Bot SDK
- [Claude Code Channels](https://code.claude.com/docs/en/channels) — MCP Channel protocol

## License

[MIT](LICENSE)

---

<a id="english"></a>

## English

**cc2wx** bridges your WeChat messages to a local Claude Code session in real time.

### How it works

```mermaid
sequenceDiagram
    participant W as WeChat
    participant API as iLink Bot API
    participant C as cc2wx
    participant CC as Claude Code

    W->>API: Send message
    C->>API: Long-poll (getUpdates)
    API-->>C: New message
    C->>CC: MCP channel notification
    CC->>C: Call weixin_reply tool
    C->>API: sendmessage
    API-->>W: Reply delivered
```

### Prerequisites

- Node.js >= 18, Claude Code CLI >= 2.1.80
- WeChat with ClawBot plugin access (currently in grayscale rollout — not all accounts have it)
- macOS or Linux (macOS auto-wraps with `caffeinate` to prevent idle sleep)

### Quick start

```bash
npx cc2wx login   # first time: scan QR → auto-launches Claude Code
npx cc2wx start   # subsequent runs (reuses saved credentials)
```

Or from source:

```bash
git clone https://github.com/roxorlt/cc2wx.git && cd cc2wx && npm install
npm run login   # scan QR → auto-launches Claude Code
npm start       # subsequent runs
```

### Security warning

`npm start` uses `--dangerously-skip-permissions` which bypasses all Claude Code permission checks. WeChat messages become prompt input, creating potential prompt injection risk. Set `CC2WX_ALLOWED_USERS` to your WeChat userId and avoid running in directories with sensitive data.

### License

[MIT](LICENSE)

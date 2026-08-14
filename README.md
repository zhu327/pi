# pi

My [pi coding agent](https://github.com/badlogic/pi-mono) configuration — custom extensions, prompts, skills, and a WeChat bridge.

## Structure

```
.pi/agent/
├── AGENTS.md              # Karpathy 风格的 agent 行为准则
├── extensions/            # 自定义扩展
│   ├── ls-grep-find.ts     # 确保 ls、grep、find 工具始终激活
│   ├── question.ts        # 结构化多问题 UI（chips、多选、预览）
│   ├── str-replace-editor.ts # 精确文件编辑（view/create/str_replace/insert）
│   ├── token-rate.ts       # 实时显示 token 输出速率（tok/s）
│   ├── todo.ts            # 4 状态任务管理 + overlay widget（/todos 命令）
│   ├── web-fetch.ts       # URL 抓取转 markdown，含 SSRF 防护
│   └── win-notify.ts      # Windows 气泡通知（切出终端时提醒，WSL/原生 Windows 通用）
├── prompts/
│   └── handoff.md         # 会话交接 prompt（替代上下文压缩）
└── skills/
    └── skill-creator/     # Skill 创建、评估、迭代优化工具链

weixin-bridge-rpc.mjs      # 微信桥接独立进程（RPC 模式，spawn pi --mode rpc）
```

## Setup

### 1. Install packages

```bash
pi install npm:@gotgenes/pi-subagents
```

- **@gotgenes/pi-subagents** — Claude Code 风格的子代理：在隔离 session 中并行执行任务，支持前台/后台运行、中途 steer、自定义 agent 类型。

### 2. web-search tool

项目中还有一个 `web-search.ts` 工具，因使用了公司内部 API，不包含在本仓库中。

可以基于 Tavily 或者 Brave 实现一个自己的 `web-search` Tool。

## Design choices

**交接优于上下文压缩。** 使用 `prompts/handoff.md` 生成结构化的交接文档，让新 agent session 可以无缝接续工作，而不是在单个超长会话中压缩上下文。交接文档保存到系统临时目录，不污染 workspace。

**Karpathy 行为准则。** `AGENTS.md` 约束 agent 行为：先想再写、最简实现、手术式改动、目标驱动执行。减少过度工程和不必要的 diff。

## Extensions

| Extension | Description |
|-----------|-------------|
| `token-rate.ts` | 在状态栏实时显示 token 输出速率（tok/s），基于 `before_provider_request` / `message_end` 事件计算 |
| `todo.ts` | `/todos` 命令，pending → in_progress → completed 的任务管理，带 TUI overlay |
| `question.ts` | 结构化提问工具，支持单选/多选/自由输入，带预览面板 |
| `web-fetch.ts` | 抓取 URL 内容并转为 markdown/text/html，内置大小限制和安全防护 |
| `ls-grep-find.ts` | session 启动时自动激活 ls、grep、find 工具 |
| `str-replace-editor.ts` | 精确文件编辑工具（view / create / str_replace / insert），自动处理 CRLF/BOM、严格 UTF-8 校验 |
| `win-notify.ts` | 检测前台窗口，切出终端时弹 Windows 气泡通知（WSL/原生 Windows 通用） |

## Windows Notify

`win-notify.ts` 通过 PowerShell 发送 Windows 气泡通知，兼容 WSL（经 `powershell.exe` 互操作）与原生 Windows 两种环境（非 Windows 环境自动禁用）。当 pi 完成任务（`agent_settled`）或 question 对话框真正打开（`question:open` 事件，提问被拦截或参数无效时不会误报）时，如果你已切出终端，就会弹出通知提醒你。

整个检测 + 通知合并为一次 PowerShell 调用，前台是终端时静默跳过，不影响 pi 正常工作。同类通知排队合并，提问通知优先插队；失败的 PowerShell 调用会退避重试且每次 session 最多告警一次。

**环境变量（均可选）：**

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_NOTIFY_DISABLED` | — | 设为 `1` 关闭整个扩展 |
| `PI_NOTIFY_FORCE` | — | 设为 `1` 跳过平台探测，强制启用（调试用） |
| `PI_NOTIFY_MODES` | `tui` | 允许触发通知的运行模式，逗号分隔（如 `tui,rpc`） |
| `PI_NOTIFY_FOCUS_APPS` | `WindowsTerminal` | 前台终端进程名列表（逗号分隔） |
| `PI_NOTIFY_SKIP_FOCUS` | — | 设为 `1` 跳过前台检测，总是通知 |
| `PI_NOTIFY_POWERSHELL` | `powershell.exe` | PowerShell 可执行文件路径 |
| `PI_NOTIFY_TITLE` | `Pi` | 通知标题 |
| `PI_NOTIFY_WAIT_SECONDS` | `8` | 气泡点击等待秒数（3-60），期间可点击通知回到终端 |
| `PI_NOTIFY_DEBUG` | — | 设为 `1` 输出详细错误到 stderr |

## WeChat bridge

`weixin-bridge-rpc.mjs` 是一个独立进程，作为微信与 pi agent 之间的桥接层：

```
┌──────────────────────┐   stdin (JSONL)   ┌─────────────────┐
│  weixin-bridge-rpc   │ ────────────────► │  pi --mode rpc  │
│  • 微信扫码登录       │                   │  无头 agent      │
│  • 消息 polling       │ ◄──────────────── │  session 持久化  │
│  • /new → new_session │   stdout (JSONL)  │                 │
│  • agent_end → 回复   │                   │                 │
└──────────────────────┘                   └─────────────────┘
```

微信消息通过 RPC JSONL 协议转发给 pi，agent 回复后自动发回微信。支持：

- 扫码登录（缓存 token，自动恢复）
- `/new` 命令新建会话（走 RPC `new_session`，绕开进程内扩展限制）
- agent 忙时消息自动排队（`follow_up`）
- 联系人和 context-token 持久化

```bash
node weixin-bridge-rpc.mjs
```

可通过 `PI_BIN` 环境变量指定 pi 可执行文件路径。

> **Note:** 该脚本调用 `https://ilinkai.weixin.qq.com` API，需要在可访问该服务的网络环境中运行。

## License

MIT

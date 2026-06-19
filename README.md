# pi

My [pi coding agent](https://github.com/badlogic/pi-mono) configuration — custom extensions, prompts, skills, and a WeChat bridge.

## Structure

```
.pi/agent/
├── AGENTS.md              # Karpathy 风格的 agent 行为准则
├── extensions/            # 自定义扩展
│   ├── grep-find.ts       # 确保 grep、find 工具始终激活
│   ├── model-patches.ts   # 模型级 patch（qwen3.7-max xhigh reasoning）
│   ├── question.ts        # 结构化多问题 UI（chips、多选、预览）
│   ├── todo.ts            # 4 状态任务管理 + overlay widget（/todos 命令）
│   └── web-fetch.ts       # URL 抓取转 markdown，含 SSRF 防护
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
pi install npm:pi-codex-goal
pi install npm:@koltmcbride/pi-loop
```

- **@gotgenes/pi-subagents** — Claude Code 风格的子代理：在隔离 session 中并行执行任务，支持前台/后台运行、中途 steer、自定义 agent 类型。
- **pi-codex-goal** - Codex 风格的 Goal 目标跟踪，设定一个完成条件后 agent 自动循环推进，直到目标达成或手动停止。
- **@koltmcbride/pi-loop** — 定时/循环 prompt 调度，可按 interval 或 cron 反复执行任务。

### 2. WeChat bridge

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

### 3. web-search tool

项目中还有一个 `web-search.ts` 工具，因使用了公司内部 API，不包含在本仓库中。

## Design choices

**交接优于上下文压缩。** 使用 `prompts/handoff.md` 生成结构化的交接文档，让新 agent session 可以无缝接续工作，而不是在单个超长会话中压缩上下文。交接文档保存到系统临时目录，不污染 workspace。

**Karpathy 行为准则。** `AGENTS.md` 约束 agent 行为：先想再写、最简实现、手术式改动、目标驱动执行。减少过度工程和不必要的 diff。

## Extensions

| Extension | Description |
|-----------|-------------|
| `todo.ts` | `/todos` 命令，pending → in_progress → completed 的任务管理，带 TUI overlay |
| `question.ts` | 结构化提问工具，支持单选/多选/自由输入，带预览面板 |
| `web-fetch.ts` | 抓取 URL 内容并转为 markdown/text/html，内置大小限制和安全防护 |
| `grep-find.ts` | session 启动时自动激活 grep、find 工具 |
| `model-patches.ts` | 为 `ali/qwen3.7-max` 注入 xhigh reasoning prompt |

## License

MIT

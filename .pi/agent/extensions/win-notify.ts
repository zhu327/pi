/**
 * Windows Notify Extension — single file.
 *
 * 当 pi 完成任务、或需要你确认（例如 question 工具提问）时，
 * 如果你已经切出终端，就通过 Windows 气泡通知提醒你。
 *
 * 适用于 WSL（通过 powershell.exe 互操作）以及原生 Windows（直接调用 PowerShell）。
 *
 * 通知逻辑移植自 notify_agent.sh（已测试可用），但不再依赖该脚本：
 *   1. 用 Win32 GetForegroundWindow 取得前台窗口的进程名
 *   2. 若前台不是配置的终端进程（即你已切出），弹 System.Windows.Forms 气泡通知
 * 整个“检测 + 通知”合并成一次 powershell 调用，避免双倍进程开销。
 *
 * REFACTOR_PLAN.md tasks implemented:
 *   - WN-1: platform detection at session_start (native win32, WSL via
 *     WSL_DISTRO_NAME/WSL_INTEROP + one-time probe); non-Windows sessions
 *     disable the extension entirely. PI_NOTIFY_FORCE=1 overrides.
 *   - WN-2: only TUI mode notifies by default; PI_NOTIFY_MODES=tui,rpc
 *     extends the mode set explicitly.
 *   - WN-3: all ChildProcess objects are tracked; session_shutdown cancels
 *     the queue and kills the active process — no 8s leftovers.
 *   - WN-4: single-flight worker, question notifications take priority,
 *     pending notifications are merged by key, dedupe time updates only
 *     after SHOWN, failures back off and never suppress future alerts.
 *   - WN-5: dedupe/queue state lives inside the extension factory and is
 *     reset on session_start; only pure config parsing is module-level.
 *   - WN-6: subscribes to the `question:open` event emitted by the question
 *     extension right before its dialog opens (never on blocked/failed
 *     tool calls).
 *   - WN-7: PI_NOTIFY_DEBUG=1 logs detailed errors; otherwise at most one
 *     short warning per session, categorized.
 *   - WN-8: empty PI_NOTIFY_FOCUS_APPS falls back to the default terminal
 *     list; balloon wait is configurable; the kill timeout is derived from
 *     it with headroom.
 *   - WN-9: handlers only enqueue (fast); the background worker is owned by
 *     the session lifecycle.
 *
 * 环境变量配置（均可选）：
 *   PI_NOTIFY_DISABLED=1     关闭整个扩展
 *   PI_NOTIFY_FORCE=1        跳过平台探测，强制启用（调试用）
 *   PI_NOTIFY_MODES          允许触发通知的模式，逗号分隔，默认 tui
 *   PI_NOTIFY_FOCUS_APPS     前台终端进程名列表（逗号分隔），默认 WindowsTerminal
 *   PI_NOTIFY_SKIP_FOCUS=1   跳过前台检测，总是通知（关闭免打扰）
 *   PI_NOTIFY_POWERSHELL     powershell 可执行文件，默认 powershell.exe
 *   PI_NOTIFY_TITLE          通知标题，默认 Pi
 *   PI_NOTIFY_WAIT_SECONDS   气泡点击等待秒数（3-60），默认 8
 *   PI_NOTIFY_DEBUG=1        详细错误输出到 stderr
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, type ChildProcess } from "node:child_process";

// ── Module level: pure configuration parsing only (state lives in the
// factory; see WN-5) ─────────────────────────────────────────────────────────

const DISABLED = process.env.PI_NOTIFY_DISABLED === "1";
const FORCE = process.env.PI_NOTIFY_FORCE === "1";
const SKIP_FOCUS = process.env.PI_NOTIFY_SKIP_FOCUS === "1";
const DEBUG = process.env.PI_NOTIFY_DEBUG === "1";
const POWERSHELL = process.env.PI_NOTIFY_POWERSHELL || "powershell.exe";
const TITLE = process.env.PI_NOTIFY_TITLE || "Pi";
const DEDUPE_MS = 3_000;
const FAILURE_BACKOFF_MS = 5_000;
const DEFAULT_FOCUS_APPS = ["WindowsTerminal"];

function parseList(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

// WN-8: an empty/whitespace FOCUS_APPS config falls back to the default list.
const rawFocusApps = parseList(process.env.PI_NOTIFY_FOCUS_APPS);
const FOCUS_APPS = rawFocusApps.length > 0 ? rawFocusApps : DEFAULT_FOCUS_APPS;

function parseWaitSeconds(): number {
	const rawEnv = process.env.PI_NOTIFY_WAIT_SECONDS;
	// An empty/whitespace value means "unset" — fall back to the default
	// instead of clamping Number("") === 0 down to the 3s minimum.
	if (rawEnv === undefined || rawEnv.trim() === "") return 8;
	const raw = Number(rawEnv);
	if (Number.isFinite(raw)) return Math.min(Math.max(Math.floor(raw), 3), 60);
	return 8;
}
const WAIT_SECONDS = parseWaitSeconds();
// Kill timeout = balloon wait + 10s headroom (WN-8).
const POWERSHELL_TIMEOUT_MS = (WAIT_SECONDS + 10) * 1000;

const NOTIFY_MODES = new Set(parseList(process.env.PI_NOTIFY_MODES).length > 0 ? parseList(process.env.PI_NOTIFY_MODES) : ["tui"]);

/** WN-1: platform support decision (pure, no process spawning). */
function detectPlatform(): "win32" | "wsl" | "unsupported" {
	if (FORCE) return "win32";
	if (process.platform === "win32") return "win32";
	if (process.platform === "linux" && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) return "wsl";
	return "unsupported";
}

/** 转义为 PowerShell 单引号字符串内的安全形式（单引号 -> 两个单引号） */
function psSingle(s: string): string {
	return s.replace(/'/g, "''");
}

/** 折叠空白并截断，避免气泡文本过长 */
function snippet(s: string, n = 80): string {
	const clean = s.replace(/\s+/g, " ").trim();
	return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

/**
 * 构造“检测前台 + 必要时弹气泡”的合并脚本。脚本结束时输出一行状态：
 * SHOWN（已弹出）/ FOCUSED（前台是终端，跳过）/ FAILED（脚本异常）。
 */
function buildNotifyScript(body: string): string {
	const title = psSingle(TITLE);
	const text = psSingle(snippet(body, 200));
	const apps = FOCUS_APPS.map((a) => `'${psSingle(a)}'`).join(",");

	const activateApp = psSingle(FOCUS_APPS[0] ?? "WindowsTerminal");
	const balloon = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName Microsoft.VisualBasic",
		"$n = New-Object System.Windows.Forms.NotifyIcon",
		"$n.Icon = [System.Drawing.SystemIcons]::Information",
		"$n.Visible = $true",
		`$n.Add_BalloonTipClicked({ try { $wt = Get-Process -Name '${activateApp}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($wt) { [Microsoft.VisualBasic.Interaction]::AppActivate($wt.Id) } } catch {} })`,
		`$n.ShowBalloonTip(5000, '${title}', '${text}', [System.Windows.Forms.ToolTipIcon]::Info)`,
		`Start-Sleep -Seconds ${WAIT_SECONDS}`,
		"$n.Dispose()",
		"Write-Output 'SHOWN'",
	].join("; ");

	if (SKIP_FOCUS) {
		return [`try { ${balloon} } catch { Write-Output 'FAILED' }`].join("\n");
	}

	return [
		'Add-Type @"',
		"using System;",
		"using System.Runtime.InteropServices;",
		"public class Win32 {",
		'    [DllImport("user32.dll")]',
		"    public static extern IntPtr GetForegroundWindow();",
		'    [DllImport("user32.dll")]',
		"    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint lpdwProcessId);",
		"}",
		'"@',
		"$procId = 0",
		"[Win32]::GetWindowThreadProcessId([Win32]::GetForegroundWindow(), [ref]$procId) > $null",
		"$p = Get-Process -Id $procId -ErrorAction SilentlyContinue",
		`if ($p.Name -notin @(${apps})) {`,
		`  try { ${balloon} } catch { Write-Output 'FAILED' }`,
		"} else {",
		"  Write-Output 'FOCUSED'",
		"}",
	].join("\n");
}

type NotifyOutcome = "shown" | "focused" | "failed";

interface QueuedNotify {
	key: string;
	body: string;
	/** true = question dialog (jumps the queue). */
	priority: boolean;
}

export default function (pi: ExtensionAPI) {
	// ── Session state (WN-5: lives here, reset on session_start) ────────────
	let sessionDisabled = DISABLED;
	let platform: "win32" | "wsl" | "unsupported" = "unsupported";
	let platformProbeDone = false;
	let platformProbe: Promise<boolean> | undefined;
	let shuttingDown = false;
	let currentMode = "tui";
	let warned = false; // WN-7: at most one short warning per session

	/** WN-3: tracked child processes, killed on shutdown. */
	const children = new Set<ChildProcess>();
	const pending = new Map<string, QueuedNotify>();
	const lastShown = new Map<string, number>();
	let workerRunning = false;

	// ── WN-7: rate-limited diagnostics (one short warning per session; ──────
	// details only with PI_NOTIFY_DEBUG=1)
	function debugLog(message: string): void {
		if (DEBUG) console.error(`[win-notify] ${message}`);
	}
	function warnOnce(category: string, message: string): void {
		debugLog(`[${category}] ${message}`);
		if (warned) return;
		warned = true;
		console.error(`[win-notify] ${message}`);
	}

	// ── WN-1: one-time powershell availability probe (WSL/Windows) ──────────
	function probePowershell(): Promise<boolean> {
		if (!platformProbe) {
			platformProbe = new Promise<boolean>((resolve) => {
				const child = execFile(
					POWERSHELL,
					["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
					{ timeout: 10_000, windowsHide: true },
					(error) => {
						children.delete(child);
						resolve(!error);
					},
				);
				children.add(child);
			});
		}
		return platformProbe;
	}

	function enabledForMode(mode: string): boolean {
		return NOTIFY_MODES.has(mode);
	}

	// ── WN-4/WN-9: enqueue is fast; the worker does the heavy lifting ───────
	function enqueue(body: string, priority: boolean): void {
		if (sessionDisabled || shuttingDown) return;
		const key = `${priority ? "q" : "s"}:${body}`;
		if (pending.has(key)) return;
		// Dedupe only after a SHOWN outcome (WN-4).
		const shownAt = lastShown.get(key);
		if (shownAt !== undefined && Date.now() - shownAt < DEDUPE_MS) return;
		if (!priority) {
			// WN-4 (fix): coalesce — distinct settled notifications that arrive
			// while one is still pending merge into a single bubble instead of
			// each waiting its own ~8s turn ("3s 内连续不同 body 只弹一个").
			for (const entry of pending.values()) {
				if (entry.priority) continue;
				const merged = coalesceBodies(entry.body, body);
				pending.delete(entry.key);
				const mergedKey = `s:${merged}`;
				pending.set(mergedKey, { key: mergedKey, body: merged, priority: false });
				void pump();
				return;
			}
		}
		pending.set(key, { key, body, priority });
		void pump();
	}

	/** Merge two settled bodies, bounded so repeats can't grow it forever. */
	function coalesceBodies(existing: string, next: string): string {
		const merged = `${existing}\n${next}`;
		return merged.length > 240 ? `${merged.slice(0, 239)}…` : merged;
	}

	function pickNext(): QueuedNotify | undefined {
		let first: QueuedNotify | undefined;
		for (const entry of pending.values()) {
			if (!first) first = entry;
			if (entry.priority) return entry; // question beats settled
		}
		return first;
	}

	async function pump(): Promise<void> {
		if (workerRunning || shuttingDown) return;
		workerRunning = true;
		try {
			for (;;) {
				if (shuttingDown) return;
				const next = pickNext();
				if (!next) return;
				const outcome = await runNotification(next.body);
				pending.delete(next.key);
				if (outcome === "shown") {
					lastShown.set(next.key, Date.now());
				} else if (outcome === "failed") {
					if (shuttingDown) return;
					warnOnce("script-failure", "win-notify: PowerShell 通知失败（详见 PI_NOTIFY_DEBUG=1）");
					// WN-4: backoff, and never mark as shown — retry stays possible.
					await sleep(FAILURE_BACKOFF_MS);
				}
				// focused: user is at the terminal — nothing shown, nothing recorded.
			}
		} finally {
			workerRunning = false;
		}
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** Run the PowerShell notification and normalize its outcome (WN-3/WN-4). */
	function runNotification(body: string): Promise<NotifyOutcome> {
		return new Promise<NotifyOutcome>((resolve) => {
			const child = execFile(
				POWERSHELL,
				["-NoProfile", "-NonInteractive", "-Command", buildNotifyScript(body)],
				{ timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true },
				(error, stdout) => {
					children.delete(child);
					if (error) {
						// A kill during shutdown is expected — stay silent.
						if (shuttingDown) {
							resolve("failed");
							return;
						}
						const kind =
							(error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }).killed
								? "timeout"
								: "spawn";
						warnOnce(kind, `win-notify: PowerShell 调用失败（${kind}，详见 PI_NOTIFY_DEBUG=1）`);
						debugLog(`[${kind}] ${error.message}`);
						resolve("failed");
						return;
					}
					const out = stdout.toString().trim();
					if (out.includes("SHOWN")) resolve("shown");
					else if (out.includes("FOCUSED")) resolve("focused");
					else {
						debugLog(`[script-failure] unexpected output: ${out}`);
						resolve("failed");
					}
				},
			);
			children.add(child);
		});
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// WN-5: fresh dedupe/queue state per session; also reap any process
		// a previous session left behind (e.g. after /reload).
		pending.clear();
		lastShown.clear();
		for (const child of children) {
			try {
				child.kill();
			} catch {
				// already exited
			}
		}
		children.clear();
		warned = false;
		shuttingDown = false;
		currentMode = ctx.mode;

		if (DISABLED) {
			sessionDisabled = true;
			return;
		}
		// WN-1: platform detection + (WSL only) a one-time probe. Nothing is
		// spawned from the factory; the first spawn happens here.
		platform = detectPlatform();
		if (platform === "unsupported") {
			sessionDisabled = true;
			debugLog(`[unsupported] platform=${process.platform}; extension disabled for this session`);
			return;
		}
		if (platform === "wsl" && !platformProbeDone) {
			platformProbeDone = true;
			const ok = await probePowershell();
			if (!ok) {
				sessionDisabled = true;
				warnOnce("unsupported", "win-notify: 检测不到 powershell.exe，本 session 已禁用通知");
				return;
			}
		}
		sessionDisabled = false;
	});

	pi.on("session_shutdown", () => {
		// WN-3: cancel queued work and kill any live PowerShell process.
		shuttingDown = true;
		pending.clear();
		lastShown.clear();
		for (const child of children) {
			try {
				child.kill();
			} catch {
				// already exited
			}
		}
		children.clear();
		sessionDisabled = true;
	});

	// pi 完成任务、空闲等待输入
	pi.on("agent_settled", (_event, ctx) => {
		if (sessionDisabled) return;
		if (!enabledForMode(ctx.mode)) return; // WN-2
		enqueue("Pi 已完成任务，等待你的下一步指令", false);
	});

	// WN-6: the question extension emits this right before its dialog opens.
	// Listening here means blocked calls, invalid params, and the text
	// fallback never produce a "needs confirmation" notification.
	pi.events.on("question:open", (data: unknown) => {
		if (sessionDisabled) return;
		if (!enabledForMode(currentMode)) return; // WN-2
		const info = (data ?? {}) as { count?: number; firstPrompt?: string };
		const count = typeof info.count === "number" && info.count > 0 ? info.count : undefined;
		const first = typeof info.firstPrompt === "string" && info.firstPrompt.trim() ? info.firstPrompt.trim() : undefined;
		let body: string;
		if (first && count && count > 1) body = `Pi 需要你确认：${snippet(first)}（另有 ${count - 1} 项）`;
		else if (first) body = `Pi 需要你确认：${snippet(first)}`;
		else body = "Pi 有问题需要你确认";
		enqueue(body, true);
	});
}

/**
 * Windows Notify Extension
 *
 * 当 pi 完成任务、或需要你确认（例如 question 工具提问）时，
 * 如果你已经切出终端，就通过 Windows 气泡通知提醒你。
 *
 * 适用于 WSL（通过 powershell.exe 互操作）以及原生 Windows（直接调用 PowerShell），
 * 两种环境下均已验证可正常工作。
 *
 * 通知逻辑移植自 notify_agent.sh（已测试可用），但不再依赖该脚本：
 *   1. 用 Win32 GetForegroundWindow 取得前台窗口的进程名
 *   2. 若前台不是配置的终端进程（即你已切出），弹 System.Windows.Forms 气泡通知
 * 整个“检测 + 通知”合并成一次 powershell 调用，避免双倍进程开销。
 *
 * 触发场景：
 *   - agent_settled      pi 完成任务、空闲等待你的下一步输入
 *   - tool_call(question) pi 正在向你提问，需要你操作
 *
 * 点击通知会把已打开的 Windows Terminal 窗口提到前台：脚本存活约 8 秒
 * 等待点击，点击时用 AppActivate 激活前台终端进程。
 *
 * 环境变量配置（均可选）：
 *   PI_NOTIFY_DISABLED=1     关闭整个扩展
 *   PI_NOTIFY_FOCUS_APPS     前台终端进程名列表（逗号分隔），默认 WindowsTerminal
 *   PI_NOTIFY_SKIP_FOCUS=1   跳过前台检测，总是通知（关闭免打扰）
 *   PI_NOTIFY_POWERSHELL     powershell 可执行文件，默认 powershell.exe
 *   PI_NOTIFY_TITLE          通知标题，默认 Pi
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

const DISABLED = process.env.PI_NOTIFY_DISABLED === "1";
const SKIP_FOCUS = process.env.PI_NOTIFY_SKIP_FOCUS === "1";
const FOCUS_APPS = (process.env.PI_NOTIFY_FOCUS_APPS || "WindowsTerminal")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const POWERSHELL = process.env.PI_NOTIFY_POWERSHELL || "powershell.exe";
const TITLE = process.env.PI_NOTIFY_TITLE || "Pi";

/** 运行一段 PowerShell 脚本，返回 stdout；失败抛错。 */
function runPowerShell(script: string, timeoutMs = 10000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			POWERSHELL,
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true },
			(err, stdout) => {
				if (err) reject(err);
				else resolve(stdout.toString());
			},
		);
	});
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
 * 构造“检测前台 + 必要时弹气泡”的合并脚本。
 * 一次 powershell 调用完成检测与通知；前台是终端时静默跳过。
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
		"Start-Sleep -Seconds 8",
		"$n.Dispose()",
	].join("; ");

	if (SKIP_FOCUS) return balloon;

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
		`if ($p.Name -notin @(${apps})) { ${balloon} }`,
	].join("\n");
}

// 简易去重：同一内容 3 秒内只通知一次，防止 agent_settled 等偶发重复触发
let lastKey = "";
let lastTime = 0;

/** 发送通知。永不抛错，绝不影响 pi。 */
async function notify(body: string): Promise<void> {
	if (DISABLED) return;
	const now = Date.now();
	if (body === lastKey && now - lastTime < 3000) return;
	lastKey = body;
	lastTime = now;
	try {
		await runPowerShell(buildNotifyScript(body), 12000);
	} catch {
		// 通知是 best-effort，失败绝不影响 pi
	}
}

/** 从 question 工具入参里提取要展示的问题文本（兼容多种 schema） */
function extractQuestionPrompt(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const obj = input as Record<string, unknown>;
	const qs = obj.questions;
	if (Array.isArray(qs) && qs.length > 0) {
		const first = qs[0] as Record<string, unknown> | undefined;
		if (first) {
			if (typeof first.prompt === "string" && first.prompt.trim()) return first.prompt.trim();
			if (typeof first.label === "string" && first.label.trim()) return first.label.trim();
		}
	}
	if (typeof obj.question === "string" && obj.question.trim()) return obj.question.trim();
	if (typeof obj.prompt === "string" && obj.prompt.trim()) return obj.prompt.trim();
	return undefined;
}

export default function (pi: ExtensionAPI) {
	// pi 完成任务、空闲等待输入
	pi.on("agent_settled", async () => {
		void notify("Pi 已完成任务，等待你的下一步指令");
	});

	// pi 正在提问，需要你操作（不 await：让提问 UI 立即出现，通知在后台发送）
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "question") return;
		try {
			const prompt = extractQuestionPrompt(event.input);
			const body = prompt ? `Pi 需要你确认：${snippet(prompt)}` : "Pi 有问题需要你确认";
			void notify(body);
		} catch {
			// 通知绝不能影响 question 工具本身
		}
	});
}

#!/usr/bin/env node
/**
 * weixin-bridge-rpc.mjs — 独立微信桥接进程（方案 B）
 *
 * 把微信连接从 pi 进程内扩展改为独立进程，pi 以 `--mode rpc` 无头运行。
 * 通过 RPC JSONL 协议通信，从而支持微信端 `/new` 等内置会话命令。
 *
 *   ┌──────────────────────┐   stdin (JSONL 命令)   ┌─────────────────┐
 *   │  本进程 (微信桥接)    │ ─────────────────────► │  pi --mode rpc  │
 *   │  • 微信登录/polling   │                        │  无头 agent      │
 *   │  • spawn pi 子进程     │ ◄───────────────────── │  session 持久化  │
 *   │  • /new→new_session   │   stdout (JSONL 事件)  │                 │
 *   │  • agent_end→回复微信  │                        │                 │
 *   └──────────────────────┘                        └─────────────────┘
 *
 * 用法：
 *   node .pi/weixin-bridge-rpc.mjs
 *
 * 行为：
 *   - 普通微信消息  →  RPC prompt（pi 忙时 follow_up 排队）
 *   - /new          →  RPC new_session（真正新建会话，核心诉求）
 *   - 其他 / 命令    →  作为 prompt 发送（扩展命令会被 pi 执行）
 *   - agent_end     →  取最后 assistant 文本回复微信
 *
 * 仅 auto-reply，不提供 LLM 主动发微信能力。
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// 配置
// ============================================================================

const PROJECT_DIR = process.cwd();
const WEIXIN_DIR = join(PROJECT_DIR, ".pi", "weixin");
const API_BASE = "https://ilinkai.weixin.qq.com";
const POLL_TIMEOUT = 35000;
const PI_BIN = process.env.PI_BIN || "pi";

// ============================================================================
// 微信状态
// ============================================================================

let botToken = "";
let botId = "";
let botBaseUrl = API_BASE;
let isConnected = false;
let pollAbort = null;
let loginTimer = null;
let loginQRCode = "";

// ============================================================================
// pi RPC 状态
// ============================================================================

let piProc = null;
let isStreaming = false; // agent_start → true, agent_end → false
const replyQueue = []; // { userId, contextToken } FIFO，与 agent_end 一一对应

// ============================================================================
// 持久化（复用 .pi/weixin 下的现有文件，兼容旧扩展缓存）
// ============================================================================

const CONTACTS_FILE = () => join(WEIXIN_DIR, "contacts.json");
const CTX_FILE = () => join(WEIXIN_DIR, "context-tokens.json");

async function loadContacts() {
  try { return JSON.parse(await readFile(CONTACTS_FILE(), "utf-8")); } catch { return {}; }
}
async function saveContact(userId) {
  const all = await loadContacts();
  all[userId] = { userId, lastSeen: new Date().toISOString() };
  if (!existsSync(WEIXIN_DIR)) await mkdir(WEIXIN_DIR, { recursive: true });
  await writeFile(CONTACTS_FILE(), JSON.stringify(all, null, 2));
}
async function loadContextTokens() {
  try { return JSON.parse(await readFile(CTX_FILE(), "utf-8")); } catch { return {}; }
}
async function saveContextToken(userId, token) {
  const all = await loadContextTokens();
  all[userId] = token;
  if (!existsSync(WEIXIN_DIR)) await mkdir(WEIXIN_DIR, { recursive: true });
  await writeFile(CTX_FILE(), JSON.stringify(all, null, 2));
}

async function saveToken(accountId, token, baseUrl) {
  if (!existsSync(WEIXIN_DIR)) await mkdir(WEIXIN_DIR, { recursive: true });
  await writeFile(
    join(WEIXIN_DIR, `${accountId}.json`),
    JSON.stringify({ accountId, token, baseUrl, savedAt: new Date().toISOString() }, null, 2),
  );
}
async function loadToken() {
  if (!existsSync(WEIXIN_DIR)) return null;
  let names;
  try { names = await readdir(WEIXIN_DIR); } catch { return null; }
  const exclude = new Set(["contacts.json", "context-tokens.json"]);
  const files = names.filter((n) => n.endsWith(".json") && !exclude.has(n));
  if (files.length === 0) return null;
  let latest = { file: "", mtime: 0 };
  for (const f of files) {
    try { const s = await stat(join(WEIXIN_DIR, f)); if (s.mtimeMs > latest.mtime) latest = { file: f, mtime: s.mtimeMs }; } catch {}
  }
  if (!latest.file) return null;
  try { return JSON.parse(await readFile(join(WEIXIN_DIR, latest.file), "utf-8")); } catch { return null; }
}

// ============================================================================
// 微信 HTTP API（从旧扩展搬出，逻辑不变）
// ============================================================================

async function post(path, body, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${botBaseUrl}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: botToken ? `Bearer ${botToken}` : "", AuthorizationType: "ilink_bot_token" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return JSON.parse(await res.text());
  } catch (err) { clearTimeout(timer); throw err; }
}

async function get(path, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${API_BASE}/${path}`, {
      method: "GET", headers: { "Content-Type": "application/json" }, signal: controller.signal,
    });
    clearTimeout(timer);
    return JSON.parse(await res.text());
  } catch (err) { clearTimeout(timer); throw err; }
}

async function fetchQRCode() {
  const data = await get("ilink/bot/get_bot_qrcode?bot_type=3");
  return { qrcode: data.qrcode, url: data.qrcode_img_content };
}

async function pollQRStatus(qrcode) {
  const data = await get(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, 35000);
  return { status: data.status, token: data.bot_token, botId: data.ilink_bot_id, baseUrl: data.baseurl };
}

async function pollMessages(getUpdatesBuf = "") {
  return post("ilink/bot/getupdates", { get_updates_buf: getUpdatesBuf, base_info: { channel_version: "1.0.0" } }, POLL_TIMEOUT);
}

async function sendWeixinMsg(to, text, contextToken) {
  await post("ilink/bot/sendmessage", {
    msg: {
      from_user_id: "", to_user_id: to,
      client_id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken ?? undefined,
    },
    base_info: { channel_version: "1.0.0" },
  });
}

function extractText(msgs) {
  const results = [];
  for (const msg of msgs ?? []) {
    if (msg.message_type === 2) continue; // 自己发的
    if (!msg.from_user_id) continue;
    let text = "";
    for (const item of msg.item_list ?? []) {
      if (item.type === 1 && item.text_item?.text != null) text += item.text_item.text;
    }
    if (!text) continue;
    results.push({ userId: msg.from_user_id, text, contextToken: msg.context_token });
  }
  return results;
}

// ============================================================================
// 微信登录与 polling
// ============================================================================

async function restoreOrLogin() {
  const cached = await loadToken();
  if (cached?.token) {
    botToken = cached.token; botId = cached.accountId; botBaseUrl = cached.baseUrl;
    isConnected = true;
    console.log(`✅ 微信会话从缓存恢复 (bot: ${botId})`);
    startPolling();
    return;
  }
  await startLogin();
}

async function startLogin() {
  const qr = await fetchQRCode();
  loginQRCode = qr.qrcode;
  console.log("\n📱 请在浏览器打开此 URL，用手机微信扫码登录：");
  console.log(`   ${qr.url}\n`);
  console.log("   等待扫码…（登录成功后会自动开始监听消息）\n");

  let attempts = 0;
  loginTimer = setInterval(async () => {
    attempts++;
    if (!loginQRCode || attempts > 480) {
      clearInterval(loginTimer); loginTimer = null; loginQRCode = "";
      console.error("⏰ 微信登录超时，请重启脚本重试。");
      failLogin();
      return;
    }
    try {
      const s = await pollQRStatus(loginQRCode);
      if (s.status === "confirmed") {
        botToken = s.token ?? ""; botId = s.botId ?? ""; botBaseUrl = s.baseUrl ?? API_BASE;
        isConnected = true;
        await saveToken(botId, botToken, botBaseUrl);
        clearInterval(loginTimer); loginTimer = null; loginQRCode = "";
        console.log("✅ 微信登录成功！开始监听消息。");
        startPolling();
      } else if (s.status === "expired") {
        clearInterval(loginTimer); loginTimer = null; loginQRCode = "";
        console.error("❌ 二维码已过期，请重启脚本重新获取。");
        failLogin();
      }
    } catch {}
  }, 1000);
}

// 登录失败/超时：退出进程，让进程管理器（systemd/pm2）可重启重试，避免半死状态。
function failLogin() {
  if (piProc) piProc.kill();
  process.exit(1);
}

async function startPolling() {
  stopPolling();
  const controller = new AbortController();
  pollAbort = controller;
  const savedCtx = await loadContextTokens();
  let buf = "";
  while (!controller.signal.aborted) {
    try {
      const resp = await pollMessages(buf);
      if (resp.get_updates_buf) buf = resp.get_updates_buf;
      if (resp.errcode === -14) { isConnected = false; console.error("⚠️ 微信连接失效 (errcode -14)，请重启脚本重新登录。"); break; }
      for (const msg of extractText(resp.msgs ?? [])) {
        await onWeixinMessage(msg, savedCtx);
      }
    } catch (err) {
      if (err.name === "AbortError") break;
      // 网络抖动等，静默重试
    }
  }
}

function stopPolling() {
  if (pollAbort) { pollAbort.abort(); pollAbort = null; }
}

// ============================================================================
// 日志与可观测性（打印 pi 返回的事件：prompt 响应 / 工具调用 / AI 回复 / 压缩重试等）
// ============================================================================

const LOG_TRUNC = 300;

function ts() {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function trunc(value, n = LOG_TRUNC) {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
}

function logPi(icon, label, detail = "") {
  console.log(detail ? `[${ts()}] ${icon} ${label} ${detail}` : `[${ts()}] ${icon} ${label}`);
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args)
    .map(([k, v]) => `${k}=${trunc(v, 120)}`)
    .join(" ");
}

function assistantText(message) {
  let t = "";
  for (const c of message?.content ?? []) if (c.type === "text") t += c.text;
  return t.trim();
}

// 取最后一条 assistant 文本回复（用于回发微信与日志）
function lastAssistantText(messages) {
  let text = "";
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const t = assistantText(m);
    if (t) text = t;
  }
  return text;
}

function toolResultPreview(result) {
  if (!result?.content) return "";
  const texts = [];
  for (const c of result.content) if (c.type === "text") texts.push(c.text);
  const full = texts.join("\n").trim();
  if (!full) return "";
  const lines = full.split("\n");
  const first = lines[0].replace(/\s+/g, " ").trim();
  const head = first.length > 80 ? `${first.slice(0, 80)}…` : first;
  return lines.length > 1 ? `${head} · +${lines.length - 1}行` : head;
}

// 汇总本次 agent_end 的助手回复数 / 工具调用数 / token 与费用
function summarizeRun(messages) {
  let assistantCount = 0, toolCallCount = 0;
  let inputTok = 0, outputTok = 0, cacheRead = 0, cost = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    assistantCount++;
    for (const c of m.content ?? []) if (c.type === "toolCall") toolCallCount++;
    const u = m.usage ?? {};
    inputTok += u.input ?? 0;
    outputTok += u.output ?? 0;
    cacheRead += u.cacheRead ?? 0;
    cost += u.cost?.total ?? 0;
  }
  return {
    finalText: lastAssistantText(messages),
    summary: `助手 ${assistantCount} 条 · 工具 ${toolCallCount} 次 · tokens 入${inputTok} 出${outputTok} 缓存${cacheRead} · $${cost.toFixed(4)}`,
  };
}

// 打印 pi 返回的事件摘要（跳过高频的 message_update，避免噪声）
function logPiEvent(ev) {
  switch (ev.type) {
    case "response":
      logPi("📨", `${ev.command} 响应 ${ev.success ? "✅" : "❌"}`, ev.success ? "" : trunc(ev.error, 200));
      break;
    case "agent_start":
      logPi("🤖", "pi 开始处理");
      break;
    case "tool_execution_start":
      logPi("🔧", `工具调用 ${ev.toolName}`, summarizeArgs(ev.args));
      break;
    case "tool_execution_end":
      logPi("🔧", `工具完成 ${ev.toolName} ${ev.isError ? "❌失败" : "✅成功"}`, toolResultPreview(ev.result));
      break;
    case "message_end":
      if (ev.message?.role === "assistant") logPi("💬", "AI 回复", trunc(assistantText(ev.message), 200));
      break;
    case "agent_end": {
      const stats = summarizeRun(ev.messages ?? []);
      logPi("✅", "pi 处理完成", stats.summary);
      if (stats.finalText) logPi("💬", "最终回复", trunc(stats.finalText, 500));
      break;
    }
    case "compaction_end":
      if (ev.result) {
        logPi("📦", `上下文压缩 ${ev.reason}`, `${ev.result.tokensBefore}→${ev.result.estimatedTokensAfter} tokens${ev.willRetry ? "（将重试）" : ""}`);
      } else {
        logPi("📦", `上下文压缩 ${ev.reason} ${ev.aborted ? "已中止" : "失败"}`, ev.errorMessage ?? "");
      }
      break;
    case "auto_retry_start":
      logPi("🔁", `自动重试 ${ev.attempt}/${ev.maxAttempts}`, trunc(ev.errorMessage, 200));
      break;
    case "auto_retry_end":
      logPi("🔁", `重试 ${ev.success ? "✅成功" : "❌失败"}（第 ${ev.attempt} 次）`, ev.success ? "" : trunc(ev.finalError, 200));
      break;
    case "extension_error":
      logPi("⚠️", `扩展错误 [${ev.event}]`, trunc(ev.error, 300));
      break;
    default:
      break;
  }
}

// ============================================================================
// pi RPC 客户端
// ============================================================================

function sendRpc(obj) {
  if (!piProc) return;
  piProc.stdin.write(JSON.stringify(obj) + "\n");
}

function sendPromptRpc(message) {
  logPi("📨", "发送 prompt", trunc(message, 200));
  sendRpc({
    type: "prompt",
    message,
    ...(isStreaming ? { streamingBehavior: "follow_up" } : {}),
  });
}

function startPi() {
  piProc = spawn(PI_BIN, ["--mode", "rpc"], { cwd: PROJECT_DIR, stdio: ["pipe", "pipe", "pipe"] });
  attachJsonlReader(piProc.stdout, onPiEvent);
  piProc.stderr.on("data", (d) => process.stderr.write(`[pi stderr] ${d}`));
  piProc.on("exit", (code) => {
    console.error(`pi 子进程退出 (code=${code})，桥接终止。`);
    process.exit(code ?? 1);
  });
  console.log(`🚀 pi RPC 子进程已启动 (PID ${piProc.pid})`);
}

function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const i = buffer.indexOf("\n");
      if (i === -1) break;
      let line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
  });
}

function onPiEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }

  logPiEvent(ev);

  switch (ev.type) {
    case "agent_start":
      isStreaming = true;
      break;
    case "agent_end":
      isStreaming = false;
      handleAgentEnd(ev);
      break;
    case "response":
      // new_session 成功后，清空旧会话遗留的回复队列
      if (ev.command === "new_session" && ev.success && !ev.data?.cancelled) {
        replyQueue.length = 0;
      }
      break;
    case "extension_ui_request": {
      // 仅 dialog 方法（select/confirm/input/editor）需要响应，否则扩展会挂起。
      // fire-and-forget 方法（setStatus/setWidget 等）无需响应。
      const dialogMethods = new Set(["select", "confirm", "input", "editor"]);
      if (ev.id && dialogMethods.has(ev.method)) {
        sendRpc({ type: "extension_ui_response", id: ev.id, cancelled: true });
      }
      break;
    }
  }
}

function handleAgentEnd(ev) {
  const target = replyQueue.shift();
  if (!target || !isConnected) return;
  const text = lastAssistantText(ev.messages ?? []);
  if (!text) return;
  sendWeixinMsg(target.userId, text, target.contextToken).catch(() => {});
}

// ============================================================================
// 微信消息 → pi RPC
// ============================================================================

async function onWeixinMessage(msg, savedCtx) {
  const contextToken = msg.contextToken || savedCtx[msg.userId];
  if (msg.contextToken) await saveContextToken(msg.userId, msg.contextToken);
  await saveContact(msg.userId);

  // /new：核心诉求，走 RPC new_session 命令（直接生效，绕开 sendUserMessage 限制）
  if (msg.text.trim() === "/new") {
    sendRpc({ type: "new_session", id: `new-${Date.now()}` });
    await sendWeixinMsg(msg.userId, "✨ 已开启新会话", contextToken).catch(() => {});
    return;
  }

  // 其他斜杠命令：作为 prompt 发送（扩展命令会被 pi 执行；内置命令无效但不报错）
  if (msg.text.startsWith("/")) {
    replyQueue.push({ userId: msg.userId, contextToken });
    sendPromptRpc(msg.text);
    return;
  }

  // 普通消息
  replyQueue.push({ userId: msg.userId, contextToken });
  sendPromptRpc(msg.text);
}

// ============================================================================
// 入口
// ============================================================================

async function main() {
  if (!existsSync(WEIXIN_DIR)) await mkdir(WEIXIN_DIR, { recursive: true });

  console.log("=== 微信桥接 (RPC 模式) 启动 ===");
  console.log(`项目目录: ${PROJECT_DIR}`);

  startPi();
  await restoreOrLogin();

  // 优雅退出
  const cleanup = () => {
    stopPolling();
    if (loginTimer) clearInterval(loginTimer);
    if (piProc) piProc.kill();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});

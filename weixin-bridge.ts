/**
 * zlab-weixin-bridge — WeChat bot extension for pi
 *
 * QR login, message polling, auto-reply, and proactive messaging
 * via the WeChat ilink API.
 *
 * https://github.com/JasonLee-arch/zxAI/tree/master/zlab-weixin-bridge
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ============================================================================
// Constants
// ============================================================================

const API_BASE = "https://ilinkai.weixin.qq.com";
const POLL_TIMEOUT = 35000;

// ============================================================================
// Global state
// ============================================================================

let botToken = "";
let botId = "";
let botBaseUrl = API_BASE;
let isConnected = false;

let pollAbort: AbortController | null = null;
let pendingReply: { userId: string; contextToken?: string } | null = null;

// Login state
let loginQRCode = "";
let loginTimer: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// Contact & context-token persistence
// ============================================================================

type UserInfo = {
  userId: string;
  alias?: string;
  lastSeen: string;
};

const CONTACTS_FILE = () => join(getWeixinDir(), "contacts.json");
const CTX_FILE = () => join(getWeixinDir(), "context-tokens.json");

async function loadContacts(): Promise<Record<string, UserInfo>> {
  try {
    return JSON.parse(await readFile(CONTACTS_FILE(), "utf-8"));
  } catch {
    return {};
  }
}

async function saveContact(userId: string, alias?: string): Promise<void> {
  const all = await loadContacts();
  all[userId] = {
    userId,
    ...(alias ? { alias } : {}),
    lastSeen: new Date().toISOString(),
  };
  const dir = getWeixinDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(CONTACTS_FILE(), JSON.stringify(all, null, 2));
}

async function loadContextTokens(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(CTX_FILE(), "utf-8"));
  } catch {
    return {};
  }
}

async function saveContextToken(userId: string, token: string): Promise<void> {
  const all = await loadContextTokens();
  all[userId] = token;
  const dir = getWeixinDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(CTX_FILE(), JSON.stringify(all, null, 2));
}

// ============================================================================
// HTTP helpers
// ============================================================================

async function post(path: string, body: unknown, timeout = 15000) {
  const url = `${botBaseUrl}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: botToken ? `Bearer ${botToken}` : "",
        AuthorizationType: "ilink_bot_token",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return JSON.parse(await res.text());
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function get(path: string, timeout = 15000) {
  const url = `${API_BASE}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return JSON.parse(await res.text());
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ============================================================================
// WeChat API calls
// ============================================================================

async function fetchQRCode() {
  const data = await get("ilink/bot/get_bot_qrcode?bot_type=3");
  return {
    qrcode: data.qrcode as string,
    url: data.qrcode_img_content as string,
  };
}

async function pollQRStatus(qrcode: string) {
  const data = await get(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    35000,
  );
  return {
    status: data.status as string,
    token: data.bot_token as string | undefined,
    botId: data.ilink_bot_id as string | undefined,
    baseUrl: data.baseurl as string | undefined,
  };
}

async function pollMessages(getUpdatesBuf = "") {
  return post(
    "ilink/bot/getupdates",
    { get_updates_buf: getUpdatesBuf, base_info: { channel_version: "1.0.0" } },
    POLL_TIMEOUT,
  );
}

async function sendWeixinMsg(
  to: string,
  text: string,
  contextToken?: string,
) {
  await post("ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken ?? undefined,
    },
    base_info: { channel_version: "1.0.0" },
  });
}

// ============================================================================
// Message extraction
// ============================================================================

function extractText(
  msgs: any[],
): { userId: string; text: string; contextToken?: string }[] {
  const results: { userId: string; text: string; contextToken?: string }[] =
    [];
  for (const msg of msgs ?? []) {
    if (msg.message_type === 2) continue;
    if (!msg.from_user_id) continue;
    let text = "";
    for (const item of msg.item_list ?? []) {
      if (item.type === 1 && item.text_item?.text != null) {
        text += item.text_item.text;
      }
    }
    if (!text) continue;
    results.push({
      userId: msg.from_user_id,
      text,
      contextToken: msg.context_token,
    });
  }
  return results;
}

// ============================================================================
// Token persistence
// ============================================================================

function getWeixinDir() {
  return join(process.cwd(), ".pi", "weixin");
}

async function saveToken(
  accountId: string,
  token: string,
  baseUrl: string,
) {
  const dir = getWeixinDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${accountId}.json`),
    JSON.stringify(
      { accountId, token, baseUrl, savedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}

async function loadToken(): Promise<{
  accountId: string;
  token: string;
  baseUrl: string;
} | null> {
  const dir = getWeixinDir();
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const exclude = new Set(["contacts.json", "context-tokens.json"]);
  const jsonFiles = names.filter(
    (n) => n.endsWith(".json") && !exclude.has(n),
  );
  if (jsonFiles.length === 0) return null;
  let latest = { file: "", mtime: 0 };
  for (const f of jsonFiles) {
    try {
      const s = await stat(join(dir, f));
      if (s.mtimeMs > latest.mtime) latest = { file: f, mtime: s.mtimeMs };
    } catch {}
  }
  if (!latest.file) return null;
  try {
    return JSON.parse(await readFile(join(dir, latest.file), "utf-8"));
  } catch {
    return null;
  }
}

// ============================================================================
// Message polling
// ============================================================================

async function startPolling(pi: ExtensionAPI) {
  stopPolling();
  const controller = new AbortController();
  pollAbort = controller;

  const savedCtx = await loadContextTokens();

  let buf = "";
  while (!controller.signal.aborted) {
    try {
      const resp = await pollMessages(buf);
      if (resp.get_updates_buf) buf = resp.get_updates_buf;
      if (resp.errcode === -14) {
        isConnected = false;
        break;
      }
      for (const msg of extractText(resp.msgs ?? [])) {
        if (msg.contextToken) {
          await saveContextToken(msg.userId, msg.contextToken);
        }
        await saveContact(msg.userId);

        const ctxToken = msg.contextToken || savedCtx[msg.userId];

        // Handle slash commands: forward as user message
        if (msg.text.startsWith("/")) {
          const cmd = msg.text.split(/\s/)[0];
          if (isConnected) {
            const confirmations: Record<string, string> = {
              "/reload": "🔄 正在重新加载…",
            };
            if (confirmations[cmd]) {
              await sendWeixinMsg(msg.userId, confirmations[cmd], ctxToken);
            }
          }
          pi.sendUserMessage(msg.text, { deliverAs: "followUp" });
          continue;
        }

        pendingReply = { userId: msg.userId, contextToken: ctxToken };

        pi.sendUserMessage(
          [{ type: "text", text: `[微信消息] ${msg.text}` }],
          { deliverAs: "followUp" },
        );
      }
    } catch (err: any) {
      if (err.name === "AbortError") break;
    }
  }
}

function stopPolling() {
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
}

// ============================================================================
// Login polling (non-blocking)
// ============================================================================

function startLoginPolling(pi: ExtensionAPI) {
  if (loginTimer) clearInterval(loginTimer);

  let attempts = 0;
  const MAX_ATTEMPTS = 480; // 8 minutes, 1-second interval

  loginTimer = setInterval(async () => {
    attempts++;
    if (!loginQRCode || attempts > MAX_ATTEMPTS) {
      clearInterval(loginTimer!);
      loginTimer = null;
      loginQRCode = "";
      if (attempts > MAX_ATTEMPTS) {
        pi.sendMessage(
          {
            customType: "weixin-status",
            content: "⏰ WeChat login timed out. Run /weixin-login to retry.",
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      }
      return;
    }

    try {
      const status = await pollQRStatus(loginQRCode);
      if (status.status === "confirmed") {
        botToken = status.token ?? "";
        botId = status.botId ?? "";
        botBaseUrl = status.baseUrl ?? API_BASE;
        isConnected = true;
        await saveToken(botId, botToken, botBaseUrl);

        clearInterval(loginTimer!);
        loginTimer = null;
        loginQRCode = "";

        startPolling(pi);

        pi.sendMessage(
          {
            customType: "weixin-status",
            content: "✅ WeChat login successful! Message monitoring started.",
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      } else if (status.status === "expired") {
        clearInterval(loginTimer!);
        loginTimer = null;
        loginQRCode = "";
        pi.sendMessage(
          {
            customType: "weixin-status",
            content: "❌ QR code expired. Run /weixin-login to get a new one.",
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      }
      // "scaned" — wait for user to confirm
    } catch {}
  }, 1000);
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // --------------------------------------------------------------------------
  // weixin_login — QR login tool
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "weixin_login",
    label: "Weixin Login",
    description:
      "Scan QR code to log in to WeChat (use your phone's WeChat to scan).",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: any,
      _params: any,
      _signal: any,
      _onUpdate: any,
      _ctx: any,
    ) {
      const cached = await loadToken();
      if (cached?.token) {
        botToken = cached.token;
        botId = cached.accountId;
        botBaseUrl = cached.baseUrl;
        isConnected = true;
        startPolling(pi);
        return {
          content: [
            {
              type: "text",
              text: "✅ WeChat session restored from cache. No QR scan needed.",
            },
          ],
          details: {},
        };
      }

      try {
        const qr = await fetchQRCode();
        loginQRCode = qr.qrcode;
        startLoginPolling(pi);

        return {
          content: [
            {
              type: "text",
              text:
                "Open this URL in your browser, then scan the QR code with WeChat on your phone:\n\n" +
                qr.url,
            },
            {
              type: "text",
              text:
                "Login result will be notified automatically. No need to wait here.",
            },
          ],
          details: { qrUrl: qr.url },
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `❌ Failed to get QR code: ${err.message}` },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });

  // --------------------------------------------------------------------------
  // weixin_send — proactive message sending
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "weixin_send",
    label: "Weixin Send",
    description:
      "Send a text message to a WeChat user. " +
      "The `to` parameter is the recipient's user ID (xxx@im.wechat format). " +
      "Use weixin_contacts to look up user IDs. " +
      "Note: auto-replies to incoming WeChat messages are handled automatically; " +
      "you do NOT need to call this tool for replies.",
    parameters: Type.Object({
      text: Type.String({ description: "Message text to send" }),
      to: Type.String({
        description: "Recipient user ID (xxx@im.wechat format, required)",
      }),
    }),
    async execute(
      _toolCallId: any,
      params: any,
      _signal: any,
      _onUpdate: any,
      _ctx: any,
    ) {
      if (!isConnected) {
        return {
          content: [
            {
              type: "text",
              text:
                "❌ WeChat is not connected. Run weixin_login first.",
            },
          ],
          details: {},
          isError: true,
        };
      }
      if (!params.to) {
        return {
          content: [
            {
              type: "text",
              text:
                "❌ Please specify the `to` parameter (recipient user ID).",
            },
          ],
          details: {},
          isError: true,
        };
      }
      try {
        const ctxTokens = await loadContextTokens();
        const contextToken = ctxTokens[params.to];
        await sendWeixinMsg(params.to, params.text, contextToken);
        return {
          content: [{ type: "text", text: "✅ Message sent." }],
          details: {},
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to send: ${err.message}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });

  // --------------------------------------------------------------------------
  // weixin_status — connection status
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "weixin_status",
    label: "Weixin Status",
    description: "Check the current WeChat connection status.",
    parameters: Type.Object({}),
    async execute() {
      const contacts = await loadContacts();
      const contactCount = Object.keys(contacts).length;
      return {
        content: [
          {
            type: "text",
            text: isConnected
              ? `✅ Connected (bot: ${botId.slice(0, 12)}..., ${contactCount} contact(s))`
              : "❌ Not connected",
          },
        ],
        details: { connected: isConnected, botId, contacts },
      };
    },
  });

  // --------------------------------------------------------------------------
  // weixin_contacts — list contacts
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "weixin_contacts",
    label: "Weixin Contacts",
    description:
      "List all known WeChat contacts and their user IDs (xxx@im.wechat format).",
    parameters: Type.Object({}),
    async execute() {
      const contacts = await loadContacts();
      const list = Object.values(contacts);
      if (list.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "📭 No contacts yet. They will appear automatically when someone sends a message.",
            },
          ],
          details: { contacts: [] },
        };
      }
      const lines = list.map(
        (c) =>
          `- ${c.alias || c.userId} \`${c.userId}\` (last active: ${c.lastSeen.slice(0, 10)})`,
      );
      return {
        content: [
          {
            type: "text",
            text: `📇 ${list.length} contact(s):\n${lines.join("\n")}`,
          },
        ],
        details: { contacts: list },
      };
    },
  });

  // --------------------------------------------------------------------------
  // weixin_alias — set contact alias
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "weixin_alias",
    label: "Weixin Alias",
    description:
      "Set a nickname for a WeChat contact for easier identification.",
    parameters: Type.Object({
      userId: Type.String({ description: "Contact user ID" }),
      alias: Type.String({ description: "Nickname (e.g. 'Alice', 'Mom')" }),
    }),
    async execute(_toolCallId: any, params: any) {
      await saveContact(params.userId, params.alias);
      return {
        content: [
          {
            type: "text",
            text: `✅ Alias set: ${params.userId} → 「${params.alias}」`,
          },
        ],
        details: {},
      };
    },
  });

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------

  pi.registerCommand("weixin-login", {
    description: "Scan QR code to log in to WeChat",
    handler: async (_args: string, ctx: any) => {
      const cached = await loadToken();
      if (cached?.token) {
        botToken = cached.token;
        botId = cached.accountId;
        botBaseUrl = cached.baseUrl;
        isConnected = true;
        startPolling(pi);
        ctx.ui.notify("✅ WeChat session restored from cache", "info");
        return;
      }

      try {
        ctx.ui.notify("⏳ Fetching WeChat login QR code...", "info");
        const qr = await fetchQRCode();
        loginQRCode = qr.qrcode;
        startLoginPolling(pi);

        const message = [
          "👉 Open this URL in your browser and scan the QR code with WeChat:",
          qr.url,
          "⏳ Waiting for scan... (you'll be notified automatically)",
        ].join("\n");

        // Show both as a notification and as a session message. Some TUI modes
        // may not render next-turn custom messages immediately, so avoid using
        // deliverAs: "nextTurn" here.
        ctx.ui.notify(`WeChat login URL: ${qr.url}`, "info");
        pi.sendMessage(
          {
            customType: "weixin-qr",
            content: message,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      } catch (err: any) {
        ctx.ui.notify(
          `❌ Failed to get QR code: ${err.message}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("weixin-status", {
    description: "Check WeChat connection status",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(
        isConnected
          ? `✅ Connected (${botId.slice(0, 12)}...)`
          : "❌ Not connected",
        isConnected ? "info" : "warn",
      );
    },
  });

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  /**
   * agent_end: After the agent finishes all turns for a prompt, auto-send
   * the final assistant response back to the WeChat user.
   *
   * Previously used message_end, but that fires per-turn — in a multi-turn
   * tool-call flow (e.g. weather query), the first turn's assistant message
   * ("Let me check...") consumed pendingReply, so the final substantive
   * response was never sent.
   */
  pi.on("agent_end", async (event: any) => {
    if (!isConnected || !pendingReply) return;

    // Find the last assistant message with text content
    const messages: any[] = event.messages ?? [];
    let lastAssistantText = "";
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      let text = "";
      for (const c of msg.content ?? []) {
        if (c.type === "text") text += c.text;
      }
      if (text.trim()) lastAssistantText = text.trim();
    }

    if (!lastAssistantText || lastAssistantText.startsWith("[微信消息]")) {
      pendingReply = null;
      return;
    }

    try {
      await sendWeixinMsg(
        pendingReply.userId,
        lastAssistantText,
        pendingReply.contextToken,
      );
      await saveContact(pendingReply.userId);
    } catch {
      // Silently fail — don't interrupt the pi session
    }

    pendingReply = null;
  });

  pi.on("session_shutdown", () => {
    stopPolling();
    isConnected = false;
    if (loginTimer) {
      clearInterval(loginTimer);
      loginTimer = null;
    }
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    // Restore WeChat connection after session switch (e.g. /new)
    // since session_shutdown stops polling and sets isConnected = false.
    if (!isConnected) {
      const cached = await loadToken();
      if (cached?.token) {
        botToken = cached.token;
        botId = cached.accountId;
        botBaseUrl = cached.baseUrl;
        isConnected = true;
        startPolling(pi);
      }
    }

    ctx.ui.notify(
      "📱 zlab-weixin-bridge loaded. Run /weixin-login to connect.",
      "info",
    );
  });
}

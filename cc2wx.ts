#!/usr/bin/env node

/**
 * cc2wx - Claude Code ↔ WeChat Bridge
 *
 * MCP Channel Server that bridges WeChat messages into Claude Code
 * via the experimental claude/channel protocol.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:cc2wx
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { WeixinBot } from '@pinixai/weixin-bot'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createDecipheriv } from 'node:crypto'

// --- Config ---
const ALLOWED_USERS = process.env.CC2WX_ALLOWED_USERS
  ? process.env.CC2WX_ALLOWED_USERS.split(',').map(s => s.trim())
  : [] // empty = allow all (first-run discovery mode)

// --- Media Download ---
const MEDIA_DIR = join(tmpdir(), 'cc2wx-media')
const CDN_DOWNLOAD_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/download'
const MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

import { readdirSync, statSync, unlinkSync } from 'node:fs'

function cleanupMedia() {
  try {
    if (!existsSync(MEDIA_DIR)) return
    const now = Date.now()
    let cleaned = 0
    for (const file of readdirSync(MEDIA_DIR)) {
      const filepath = join(MEDIA_DIR, file)
      const age = now - statSync(filepath).mtimeMs
      if (age > MEDIA_MAX_AGE_MS) {
        unlinkSync(filepath)
        cleaned++
      }
    }
    if (cleaned > 0) console.log(`[cc2wx] Cleaned ${cleaned} expired media files`)
  } catch (err) {
    console.error(`[cc2wx] Media cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function parseAesKey(aesKeyB64: string): Buffer {
  // Double-encoded: base64 → hex string (32 chars) → 16 byte raw key
  const hexStr = Buffer.from(aesKeyB64, 'base64').toString('utf8')
  return Buffer.from(hexStr, 'hex')
}

function detectExt(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif'
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'webp'
  // Video formats
  if (buf.length >= 8 && buf.slice(4, 8).toString('ascii') === 'ftyp') return 'mp4'
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm'
  // Document formats
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf'
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip' // also docx/xlsx/pptx
  // Audio formats
  if (buf[0] === 0x23 && buf[1] === 0x21 && buf[2] === 0x41 && buf[3] === 0x4d) return 'amr'
  if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === 'OggS') return 'ogg'
  return 'bin'
}

async function downloadMedia(item: any): Promise<string | null> {
  const mediaItem = item?.image_item || item?.video_item || item?.file_item || item?.voice_item
  if (!mediaItem?.media?.encrypt_query_param) return null

  const { encrypt_query_param, aes_key } = mediaItem.media

  try {
    const cdnUrl = `${CDN_DOWNLOAD_URL}?encrypted_query_param=${encodeURIComponent(encrypt_query_param)}`
    const resp = await fetch(cdnUrl, { method: 'GET', signal: AbortSignal.timeout(30_000) })

    if (!resp.ok) {
      console.log(`[cc2wx] CDN download failed: HTTP ${resp.status}`)
      return null
    }

    let buffer = Buffer.from(await resp.arrayBuffer())

    // Decrypt with AES-128-ECB if we have a key
    if (aes_key) {
      const key = parseAesKey(aes_key)
      const decipher = createDecipheriv('aes-128-ecb', key, Buffer.alloc(0))
      buffer = Buffer.concat([decipher.update(buffer), decipher.final()])
    }

    mkdirSync(MEDIA_DIR, { recursive: true })
    const ext = detectExt(buffer)
    const filename = `${Date.now()}.${ext}`
    const filepath = join(MEDIA_DIR, filename)
    writeFileSync(filepath, buffer)
    console.log(`[cc2wx] Media saved: ${filepath} (${buffer.length} bytes, ${ext})`)
    return filepath
  } catch (err) {
    console.error(`[cc2wx] Media download failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// Redirect bot's console output to stderr AND log file
import { appendFileSync } from 'node:fs'
const LOG_FILE = join(tmpdir(), 'cc2wx.log')
function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`
  process.stderr.write(line)
  try { appendFileSync(LOG_FILE, line) } catch {}
}
console.log = log
console.error = (...args: unknown[]) => log('[ERROR]', ...args)

// --- MCP Server ---
const server = new Server(
  { name: 'cc2wx', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      '微信消息通过 <channel source="cc2wx"> 到达。',
      '使用 weixin_reply 工具回复微信消息。',
      '回复不限长度，cc2wx 会自动分段发送到微信。',
    ].join('\n'),
  },
)

// --- WeChat Bot ---
const bot = new WeixinBot()

// Track recent messages for reply context
const recentMessages = new Map() // userId -> IncomingMessage

// Track pending permission request (latest one wins)
// Queue of pending permission requests (FIFO) — supports concurrent requests
const pendingPermissions: Array<{ requestId: string; toolName: string }> = []

// --- Always Allow: persistent low-risk action list ---
const ALLOW_LIST_PATH = join(homedir(), '.cc2wx', 'always-allow.json')

function loadAllowList(): Set<string> {
  try {
    if (existsSync(ALLOW_LIST_PATH)) {
      const data = JSON.parse(readFileSync(ALLOW_LIST_PATH, 'utf8'))
      console.log(`[cc2wx] Loaded ${data.length} always-allow patterns from ${ALLOW_LIST_PATH}`)
      return new Set(data)
    }
  } catch (err) {
    console.error(`[cc2wx] Failed to load allow list: ${err instanceof Error ? err.message : String(err)}`)
  }
  return new Set()
}

function saveAllowList(patterns: Set<string>) {
  try {
    const dir = join(homedir(), '.cc2wx')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(ALLOW_LIST_PATH, JSON.stringify([...patterns], null, 2) + '\n', { mode: 0o600 })
    console.log(`[cc2wx] Saved ${patterns.size} always-allow patterns to ${ALLOW_LIST_PATH}`)
  } catch (err) {
    console.error(`[cc2wx] Failed to save allow list: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const alwaysAllowPatterns = loadAllowList()

// --- Tool: weixin_reply ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'weixin_reply',
      description: '回复微信消息给最近发消息的用户',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '回复内容' },
          user_id: {
            type: 'string',
            description: '目标用户 ID（可选，默认回复最近一条消息的发送者）',
          },
        },
        required: ['text'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'weixin_reply') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    }
  }

  const args = request.params.arguments ?? {}
  const text = typeof args.text === 'string' ? args.text
    : typeof args.content === 'string' ? args.content  // Claude occasionally sends 'content' instead of 'text'
    : undefined
  const rawUid = args.user_id ?? args.userId
  const user_id = typeof rawUid === 'string' ? rawUid : undefined

  if (!text) {
    return {
      content: [{ type: 'text', text: `参数错误: 缺少 text 字段 (收到的参数: ${JSON.stringify(Object.keys(args))})` }],
      isError: true,
    }
  }

  const targetId = user_id || [...recentMessages.keys()].pop()

  if (!targetId) {
    return {
      content: [{ type: 'text', text: '没有可回复的用户，等待微信消息...' }],
      isError: true,
    }
  }

  const cachedMsg = recentMessages.get(targetId)

  // 自动分段：按段落拆分，每段不超过 MAX_CHUNK 字符
  const MAX_CHUNK = 2000
  const chunks: string[] = []
  if (text.length <= MAX_CHUNK) {
    chunks.push(text)
  } else {
    // 优先按双换行（段落）拆分，其次按单换行，最后硬切
    let remaining = text
    while (remaining.length > MAX_CHUNK) {
      let cutAt = remaining.lastIndexOf('\n\n', MAX_CHUNK)
      if (cutAt <= 0) cutAt = remaining.lastIndexOf('\n', MAX_CHUNK)
      if (cutAt <= 0) cutAt = MAX_CHUNK
      chunks.push(remaining.slice(0, cutAt))
      remaining = remaining.slice(cutAt).replace(/^\n+/, '')
    }
    if (remaining) chunks.push(remaining)
  }

  try {
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n${chunks[i]}` : chunks[i]
      if (cachedMsg) {
        await bot.reply(cachedMsg, part)
      } else {
        await bot.send(targetId, part)
      }
      // 多段之间稍等避免消息乱序
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500))
    }
    return {
      content: [{ type: 'text', text: `已发送到微信用户 ${targetId}（${chunks.length} 段）` }],
    }
  } catch (err: unknown) {
    return {
      content: [{ type: 'text', text: `发送失败: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
})

// --- Permission Relay: forward CC permission prompts to WeChat ---
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  console.log(`[cc2wx] ✅ Permission request received! id=${params.request_id} tool=${params.tool_name}`)

  // Auto-approve if tool matches an "always allow" pattern (silent, no WeChat notification)
  if (alwaysAllowPatterns.has(params.tool_name)) {
    console.log(`[cc2wx] Auto-approved ${params.tool_name} (always allow)`)
    try {
      await server.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: params.request_id, behavior: 'allow' },
      })
    } catch (err) {
      console.error(`[cc2wx] Auto-approve failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }

  // Find the most recent user to send the prompt to
  const targetId = [...recentMessages.keys()].pop()
  if (!targetId) {
    console.log('[cc2wx] Permission request received but no active user to forward to')
    return
  }

  const cachedMsg = recentMessages.get(targetId)

  // Format input_preview: try to parse JSON for better readability
  let preview = params.input_preview
  try {
    const parsed = JSON.parse(preview)
    if (parsed.command) preview = parsed.command
    else if (parsed.file_path) preview = parsed.file_path
    else preview = JSON.stringify(parsed, null, 2)
  } catch { /* keep original string */ }

  // Enqueue so user can reply in order (FIFO)
  pendingPermissions.push({ requestId: params.request_id, toolName: params.tool_name })

  const prompt = [
    `🔐 Claude 请求权限`,
    `工具: ${params.tool_name}`,
    `说明: ${params.description}`,
    '',
    preview.slice(0, 800),
    '',
    `回复 yes 批准 / always 始终批准 / no 拒绝`,
  ].join('\n')

  try {
    if (cachedMsg) {
      await bot.reply(cachedMsg, prompt)
    } else {
      await bot.send(targetId, prompt)
    }
    console.log(`[cc2wx] Permission request ${params.request_id} forwarded to ${targetId}`)
  } catch (err) {
    console.error(`[cc2wx] Failed to forward permission request: ${err instanceof Error ? err.message : String(err)}`)
  }
})

// Regex for permission verdict replies: "yes abc12", "no abc12", "yes abc12 批准" etc.
// Lenient: allows trailing text (user might append "批准"/"拒绝" etc.)
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})/i

// --- Message Handler ---
bot.onMessage(async (msg) => {
  // Allowlist check
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(msg.userId)) {
    console.log(`[cc2wx] Blocked message from unlisted user: ${msg.userId}`)
    return
  }

  console.log(`[cc2wx] 收到微信消息 from=${msg.userId} type=${msg.type}: ${msg.text?.slice(0, 100)}`)

  // Cache for reply
  recentMessages.set(msg.userId, msg)

  // Intercept permission verdict replies
  // Supports: "yes", "ok", "y", "no", "n" (uses pending id) or "yes abc12" (explicit id)
  if (msg.type === 'text' && msg.text && pendingPermissions.length > 0) {
    const SIMPLE_RE = /^\s*(y|yes|ok|好|批准|always|始终|总是|n|no|不|拒绝)\s*$/i
    const simpleMatch = msg.text.match(SIMPLE_RE)
    const explicitMatch = msg.text.match(PERMISSION_REPLY_RE)

    const match = explicitMatch || simpleMatch
    if (match) {
      const reply = (explicitMatch ? match[1] : match[1]).trim().toLowerCase()
      const isAlways = /^(always|始终|总是)$/.test(reply)
      const isAllow = isAlways || /^(y|yes|ok|好|批准)$/i.test(reply)

      // Explicit ID targets a specific request; simple reply targets the oldest (FIFO)
      let pending: { requestId: string; toolName: string } | undefined
      if (explicitMatch) {
        const explicitId = match[2].toLowerCase()
        const idx = pendingPermissions.findIndex(p => p.requestId === explicitId)
        if (idx >= 0) pending = pendingPermissions.splice(idx, 1)[0]
      } else {
        pending = pendingPermissions.shift() // FIFO: consume the oldest
      }

      if (!pending) {
        // No matching request found — fall through to normal message handling
      } else {
        // "always" → remember this tool pattern for auto-approve (persisted to disk)
        if (isAlways) {
          alwaysAllowPatterns.add(pending.toolName)
          saveAllowList(alwaysAllowPatterns)
          console.log(`[cc2wx] Always allow added: ${pending.toolName} (total: ${alwaysAllowPatterns.size})`)
        }

        try {
          await server.notification({
            method: 'notifications/claude/channel/permission',
            params: { request_id: pending.requestId, behavior: isAllow ? 'allow' : 'deny' },
          })
          console.log(`[cc2wx] Permission verdict sent: ${pending.requestId} → ${isAllow ? 'allow' : 'deny'}${isAlways ? ' (always)' : ''}`)
          // Acknowledge to user
          const cachedMsg = recentMessages.get(msg.userId)
          let ack: string
          if (isAlways) ack = `✅ 已批准，后续 ${pending.toolName} 自动批准`
          else if (isAllow) ack = `✅ 已批准`
          else ack = `❌ 已拒绝`
          // If more pending, hint the user
          if (pendingPermissions.length > 0) {
            ack += `\n⏳ 还有 ${pendingPermissions.length} 个权限请求等待回复`
          }
          if (cachedMsg) await bot.reply(cachedMsg, ack)
          else await bot.send(msg.userId, ack)
        } catch (err) {
          console.error(`[cc2wx] Failed to send permission verdict: ${err instanceof Error ? err.message : String(err)}`)
        }

        // If "always" was chosen, auto-approve remaining requests for the same tool
        if (isAlways) {
          const toAutoApprove = pendingPermissions.filter(p => p.toolName === pending!.toolName)
          for (const p of toAutoApprove) {
            try {
              await server.notification({
                method: 'notifications/claude/channel/permission',
                params: { request_id: p.requestId, behavior: 'allow' },
              })
              console.log(`[cc2wx] Auto-approved queued ${p.toolName} (${p.requestId}) via always-allow`)
            } catch (err) {
              console.error(`[cc2wx] Failed to auto-approve queued: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          // Remove auto-approved items from queue
          const toolName = pending.toolName
          let i = pendingPermissions.length
          while (i--) {
            if (pendingPermissions[i].toolName === toolName) pendingPermissions.splice(i, 1)
          }
        }

        return // Don't forward verdict to Claude as a message
      }
    }
  }
  // Keep map small
  if (recentMessages.size > 50) {
    const oldest = recentMessages.keys().next().value
    recentMessages.delete(oldest)
  }

  // Handle non-text messages
  let mediaPath: string | null = null
  if (msg.type !== 'text' && (msg as any).raw?.item_list?.[0]) {
    // Voice: use ClawBot STT transcription, never download audio (Claude can't read it)
    if (msg.type === 'voice') {
      const voiceText = msg.text || (msg as any).raw?.item_list?.[0]?.voice_item?.text
      if (voiceText) {
        ;(msg as any)._voiceText = voiceText
        console.log(`[cc2wx] Voice with transcription: ${voiceText.slice(0, 50)}`)
      } else {
        console.log(`[cc2wx] Voice without transcription, STT failed`)
      }
    } else {
      mediaPath = await downloadMedia((msg as any).raw.item_list[0])
    }
  }

  // Build content for channel notification
  let content: string
  const voiceText = (msg as any)._voiceText || msg.text
  if (msg.type === 'voice' && voiceText) {
    content = `[微信 ${msg.userId}] (语音转文字) ${voiceText}`
  } else if (msg.type === 'voice') {
    content = `[微信 ${msg.userId}] (语音消息，无法识别，请发文字或文字转写)`
  } else if (mediaPath) {
    content = `[微信 ${msg.userId}] (${msg.type} 已下载到 ${mediaPath})`
  } else if (msg.type !== 'text') {
    content = `[微信 ${msg.userId}] (${msg.type} 消息，下载失败，请发文字)`
  } else {
    content = `[微信 ${msg.userId}] ${msg.text}`
  }

  // Push to Claude Code as channel event
  try {
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          userId: msg.userId,
          type: msg.type,
          source: 'weixin',
          timestamp: msg.timestamp?.toISOString(),
        },
      },
    })
  } catch (err: unknown) {
    console.error(`[cc2wx] Failed to push channel notification: ${err instanceof Error ? err.message : String(err)}`)
  }
})

// --- Startup ---
async function main() {
  const credPath = join(homedir(), '.weixin-bot', 'credentials.json')

  if (!existsSync(credPath)) {
    console.error('[cc2wx] 未找到微信登录凭证!')
    console.error('[cc2wx] 请先运行: node login.mjs')
    process.exit(1)
  }

  // Clean up expired media files on startup + every 6 hours
  cleanupMedia()
  setInterval(cleanupMedia, 6 * 60 * 60 * 1000)

  // Connect MCP stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.log('[cc2wx] MCP server connected via stdio')

  // Login with saved credentials (no QR code needed)
  console.log('[cc2wx] 使用已保存的凭证登录微信...')
  const creds = await bot.login()
  console.log(`[cc2wx] 微信连接成功! accountId=${creds.accountId}`)

  if (ALLOWED_USERS.length === 0) {
    console.log('[cc2wx] ⚠ 白名单为空，将接受所有用户消息')
    console.log('[cc2wx] 发一条消息后查看日志获取你的 userId，然后设置:')
    console.log('[cc2wx]   CC2WX_ALLOWED_USERS=your_user_id')
  }

  // Start polling (blocks)
  console.log('[cc2wx] 开始监听微信消息...')
  await bot.run()
}

main().catch((err) => {
  console.error(`[cc2wx] Fatal: ${err.message}`)
  process.exit(1)
})

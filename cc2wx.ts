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

// --- Config ---
const ALLOWED_USERS = process.env.CC2WX_ALLOWED_USERS
  ? process.env.CC2WX_ALLOWED_USERS.split(',').map(s => s.trim())
  : [] // empty = allow all (first-run discovery mode)

// Redirect bot's console output to stderr so it doesn't corrupt MCP stdio
console.log = (...args: unknown[]) => process.stderr.write(args.join(' ') + '\n')
console.error = (...args: unknown[]) => process.stderr.write('[ERROR] ' + args.join(' ') + '\n')

// --- MCP Server ---
const server = new Server(
  { name: 'cc2wx', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
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

  const { text, user_id } = request.params.arguments
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
  // Keep map small
  if (recentMessages.size > 50) {
    const oldest = recentMessages.keys().next().value
    recentMessages.delete(oldest)
  }

  // Push to Claude Code as channel event
  // This is a Claude Code extension - not in SDK types but works at runtime
  try {
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `[微信 ${msg.userId}] ${msg.text || `(${msg.type} 消息)`}`,
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
  // Check if credentials exist before connecting MCP
  const fs = await import('node:fs')
  const path = await import('node:path')
  const os = await import('node:os')
  const credPath = path.join(os.homedir(), '.weixin-bot', 'credentials.json')

  if (!fs.existsSync(credPath)) {
    console.error('[cc2wx] 未找到微信登录凭证!')
    console.error('[cc2wx] 请先运行: node login.mjs')
    process.exit(1)
  }

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

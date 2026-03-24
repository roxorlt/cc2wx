#!/usr/bin/env node

/**
 * cc2dt - Claude Code ↔ DingTalk Bridge
 *
 * MCP Channel Server that sends messages to DingTalk group via custom robot webhook,
 * and optionally receives @mention callbacks via HTTP.
 *
 * Send: webhook + HMAC-SHA256 signing → DingTalk group
 * Receive: HTTP POST /callback ← DingTalk outgoing (requires public URL, e.g. ngrok)
 *
 * Config: ~/.cc2dt/config.json or env vars (CC2DT_WEBHOOK, CC2DT_SECRET, CC2DT_PORT)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// --- Config ---
const CONFIG_PATH = join(homedir(), '.cc2dt', 'config.json')

interface Config {
  webhookUrl: string
  signSecret: string
  port?: number
  allowedUsers?: string[]
}

function loadConfig(): Config {
  // Env vars take precedence
  if (process.env.CC2DT_WEBHOOK && process.env.CC2DT_SECRET) {
    return {
      webhookUrl: process.env.CC2DT_WEBHOOK,
      signSecret: process.env.CC2DT_SECRET,
      port: parseInt(process.env.CC2DT_PORT || '8089'),
      allowedUsers: process.env.CC2DT_ALLOWED_USERS
        ? process.env.CC2DT_ALLOWED_USERS.split(',').map(s => s.trim())
        : [],
    }
  }

  if (!existsSync(CONFIG_PATH)) {
    process.stderr.write(`[cc2dt] Config not found: ${CONFIG_PATH}\n`)
    process.stderr.write('[cc2dt] Create it with: { "webhookUrl": "...", "signSecret": "..." }\n')
    process.exit(1)
  }

  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
}

// Redirect console to stderr (MCP uses stdio)
console.log = (...args: unknown[]) => process.stderr.write(args.join(' ') + '\n')
console.error = (...args: unknown[]) => process.stderr.write('[ERROR] ' + args.join(' ') + '\n')

const config = loadConfig()
const PORT = config.port || 8089
const ALLOWED_USERS = config.allowedUsers || []

// --- DingTalk Signing (https://open.dingtalk.com/document/dingstart/customize-robot-security-settings) ---
function dingtalkSign(timestamp: number): string {
  const stringToSign = `${timestamp}\n${config.signSecret}`
  return createHmac('sha256', config.signSecret)
    .update(stringToSign)
    .digest('base64')
}

function verifyCallback(timestamp: string, sign: string): boolean {
  const ts = parseInt(timestamp)
  // Reject if timestamp is older than 1 hour
  if (Math.abs(Date.now() - ts) > 3600000) return false
  return sign === dingtalkSign(ts)
}

// --- Send to DingTalk ---
async function sendToDingtalk(content: string, msgtype: 'text' | 'markdown' = 'markdown') {
  const timestamp = Date.now()
  const sign = encodeURIComponent(dingtalkSign(timestamp))
  const url = `${config.webhookUrl}&timestamp=${timestamp}&sign=${sign}`

  let body: Record<string, unknown>
  if (msgtype === 'markdown') {
    const title = content.split('\n')[0].replace(/^#+\s*/, '').slice(0, 30) || '消息'
    body = { msgtype: 'markdown', markdown: { title, text: content } }
  } else {
    body = { msgtype: 'text', text: { content } }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const result = (await res.json()) as { errcode: number; errmsg: string }
  if (result.errcode !== 0) {
    throw new Error(`DingTalk API: ${result.errmsg} (code: ${result.errcode})`)
  }
  return result
}

// --- MCP Server ---
const server = new Server(
  { name: 'cc2dt', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      '钉钉消息通过 <channel source="cc2dt"> 到达。',
      '使用 dingtalk_send 工具发送消息到钉钉群。',
      '支持 text 和 markdown 两种格式，markdown 格式下链接可点击。',
    ].join('\n'),
  },
)

// --- Tool: dingtalk_send ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'dingtalk_send',
      description: '发送消息到钉钉群（支持 text 和 markdown 格式）',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '消息内容' },
          format: {
            type: 'string',
            enum: ['text', 'markdown'],
            description: '消息格式：text（纯文本）或 markdown（链接可点击、支持加粗等）。默认 markdown',
          },
        },
        required: ['text'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'dingtalk_send') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    }
  }

  const { text, format = 'markdown' } = request.params.arguments as {
    text: string
    format?: string
  }

  try {
    // DingTalk limits: markdown 20000 chars, text 2048 chars
    const maxLen = format === 'markdown' ? 20000 : 2048

    if (text.length <= maxLen) {
      await sendToDingtalk(text, format as 'text' | 'markdown')
      return { content: [{ type: 'text', text: '已发送到钉钉群' }] }
    }

    // Split long messages by paragraphs
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > maxLen) {
      let cutAt = remaining.lastIndexOf('\n\n', maxLen)
      if (cutAt <= 0) cutAt = remaining.lastIndexOf('\n', maxLen)
      if (cutAt <= 0) cutAt = maxLen
      chunks.push(remaining.slice(0, cutAt))
      remaining = remaining.slice(cutAt).replace(/^\n+/, '')
    }
    if (remaining) chunks.push(remaining)

    for (let i = 0; i < chunks.length; i++) {
      await sendToDingtalk(chunks[i], format as 'text' | 'markdown')
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500))
    }

    return {
      content: [{ type: 'text', text: `已发送到钉钉群（${chunks.length} 段）` }],
    }
  } catch (err: unknown) {
    return {
      content: [
        { type: 'text', text: `发送失败: ${err instanceof Error ? err.message : String(err)}` },
      ],
      isError: true,
    }
  }
})

// --- HTTP Server for receiving DingTalk callbacks ---
function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Health check
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('cc2dt running')
    return
  }

  if (req.method !== 'POST' || req.url !== '/callback') {
    res.writeHead(404)
    res.end('not found')
    return
  }

  try {
    const body = await parseBody(req)
    const data = JSON.parse(body)

    // Verify signature (DingTalk sends timestamp + sign in headers)
    const timestamp = req.headers['timestamp'] as string
    const sign = req.headers['sign'] as string

    if (timestamp && sign && !verifyCallback(timestamp, sign)) {
      console.log('[cc2dt] Signature verification failed')
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    // Allowlist check
    const senderId = data.senderStaffId || data.senderId || ''
    if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(senderId)) {
      console.log(`[cc2dt] Blocked message from unlisted user: ${senderId}`)
      res.writeHead(200)
      res.end('ok')
      return
    }

    const sender = data.senderNick || senderId || 'unknown'
    const text = data.text?.content?.trim() || `(${data.msgtype} 消息)`
    const group = data.conversationTitle || ''

    console.log(`[cc2dt] 收到钉钉消息 from=${sender} group=${group}: ${text.slice(0, 100)}`)

    // Push to Claude Code as channel event
    try {
      await server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `[钉钉 ${sender}${group ? '@' + group : ''}] ${text}`,
          meta: {
            senderId,
            senderNick: data.senderNick,
            group: data.conversationTitle,
            conversationId: data.conversationId,
            sessionWebhook: data.sessionWebhook,
            source: 'dingtalk',
            timestamp: data.createAt ? new Date(data.createAt).toISOString() : undefined,
          },
        },
      })
    } catch (err: unknown) {
      console.error(
        `[cc2dt] Failed to push channel notification: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    res.writeHead(200)
    res.end('ok')
  } catch (err) {
    console.error(`[cc2dt] Callback error: ${err}`)
    res.writeHead(500)
    res.end('error')
  }
})

// --- Startup ---
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.log('[cc2dt] MCP server connected via stdio')

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[cc2dt] HTTP callback server listening on port ${PORT}`)
    console.log(`[cc2dt] Callback URL: http://localhost:${PORT}/callback`)
    console.log('[cc2dt] (需要 ngrok 等工具暴露公网 URL 才能接收钉钉 @mention 消息)')
  })

  console.log('[cc2dt] DingTalk bridge ready')
  console.log(`[cc2dt] Webhook configured: ${config.webhookUrl.slice(0, 50)}...`)

  if (ALLOWED_USERS.length === 0) {
    console.log('[cc2dt] ⚠ 白名单为空，将接受所有回调消息')
  }
}

main().catch((err) => {
  console.error(`[cc2dt] Fatal: ${err.message}`)
  process.exit(1)
})

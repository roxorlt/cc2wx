#!/usr/bin/env node

/**
 * Shared launch helpers for cc2wx CLI scripts.
 * Single source of truth for Claude Code startup args and .mcp.json management.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Ensure .mcp.json in cwd points to this package's cc2wx.ts
 */
export function ensureMcpJson() {
  const cc2wxTs = path.join(__dirname, 'cc2wx.ts')
  const mcpPath = path.join(process.cwd(), '.mcp.json')
  const entry = { command: 'npx', args: ['tsx', cc2wxTs] }

  if (existsSync(mcpPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf8'))
      const existingArgs = existing?.mcpServers?.cc2wx?.args
      if (existingArgs && existingArgs.includes(cc2wxTs)) return
      existing.mcpServers = existing.mcpServers || {}
      existing.mcpServers.cc2wx = entry
      writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n')
      console.log(`[cc2wx] Updated .mcp.json -> ${cc2wxTs}`)
    } catch {
      writeFileSync(mcpPath, JSON.stringify({ mcpServers: { cc2wx: entry } }, null, 2) + '\n')
      console.log(`[cc2wx] Created .mcp.json -> ${cc2wxTs}`)
    }
  } else {
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { cc2wx: entry } }, null, 2) + '\n')
    console.log(`[cc2wx] Created .mcp.json -> ${cc2wxTs}`)
  }
}

/**
 * Launch Claude Code with cc2wx channel, wrapped in caffeinate on macOS.
 */
export function launchClaude() {
  ensureMcpJson()

  const claudeArgs = [
    '--dangerously-load-development-channels', 'server:cc2wx',
    '--effort', 'max',
  ]

  const isWin = process.platform === 'win32'
  let cmd, args, options

  if (process.platform === 'darwin') {
    cmd = 'caffeinate'
    args = ['-i', 'claude', ...claudeArgs]
    options = { stdio: 'inherit', cwd: process.cwd() }
  } else if (isWin) {
    // On Windows, --dangerously-load-development-channels activates --print mode,
    // which requires an initial stdin line before Claude enters channel-listen mode.
    // Piping "start" via cmd.exe provides that trigger so Claude stays alive
    // waiting for MCP/WeChat notifications instead of exiting immediately.
    const argStr = claudeArgs.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')
    cmd = 'cmd.exe'
    args = ['/c', `echo start | claude ${argStr}`]
    options = { stdio: 'inherit', cwd: process.cwd() }
  } else {
    cmd = 'claude'
    args = claudeArgs
    options = { stdio: 'inherit', cwd: process.cwd() }
  }

  const child = spawn(cmd, args, options)
  child.on('exit', (code) => process.exit(code ?? 0))
}

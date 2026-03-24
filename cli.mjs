#!/usr/bin/env node

/**
 * cc2wx CLI - Claude Code <-> WeChat bridge
 *
 * Commands:
 *   cc2wx login   - QR code login + auto-start Claude Code
 *   cc2wx start   - Start Claude Code with WeChat channel (default)
 *   cc2wx serve   - Run MCP server directly (for debugging)
 *   cc2wx --help  - Show usage
 */

import { existsSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { launchClaude } from './launch.mjs'

// Resolve paths relative to THIS file (works whether cloned or npm-installed)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PKG_DIR = __dirname

const CRED_PATH = path.join(os.homedir(), '.weixin-bot', 'credentials.json')

const BANNER = [
  '',
  '\x1b[36m\x1b[1m   ██████╗ ██████╗██████╗ ██╗    ██╗██╗  ██╗\x1b[0m',
  '\x1b[36m\x1b[1m  ██╔════╝██╔════╝╚════██╗██║    ██║╚██╗██╔╝\x1b[0m',
  '\x1b[36m\x1b[1m  ██║     ██║      █████╔╝██║ █╗ ██║ ╚███╔╝ \x1b[0m',
  '\x1b[36m\x1b[1m  ██║     ██║     ██╔═══╝ ██║███╗██║ ██╔██╗ \x1b[0m',
  '\x1b[36m\x1b[1m  ╚██████╗╚██████╗███████╗╚███╔███╔╝██╔╝ ██╗\x1b[0m',
  '\x1b[36m\x1b[1m   ╚═════╝ ╚═════╝╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝\x1b[0m',
  '\x1b[2m      Claude Code ↔ WeChat Bridge\x1b[0m',
  '\x1b[2m              by \x1b[0m\x1b[33mroxorlt\x1b[0m',
  '',
].join('\n')

const HELP = `
cc2wx - Claude Code <-> WeChat bridge

Usage:
  cc2wx              Start Claude Code with WeChat channel (alias: cc2wx start)
  cc2wx login        Scan QR code to log in, then auto-start Claude Code
  cc2wx start        Start Claude Code with WeChat channel
  cc2wx serve        Run MCP channel server directly (debug mode)
  cc2wx --help       Show this help

Environment variables:
  CC2WX_ALLOWED_USERS   Comma-separated user IDs to accept messages from (empty = all)

Credentials are stored in ~/.weixin-bot/credentials.json
`.trim()

function hasCredentials() {
  return existsSync(CRED_PATH)
}

// --- Commands ---

function runLogin() {
  console.log(BANNER)
  // Fork login.mjs from the package directory
  const loginScript = path.join(PKG_DIR, 'login.mjs')
  const child = spawn(process.execPath, [loginScript], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env },
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}

function runStart() {
  if (!hasCredentials()) {
    console.error('未找到微信登录凭证!')
    console.error('请先运行: cc2wx login')
    process.exit(1)
  }

  console.log(BANNER)
  console.log('  Send a message to your WeChat to talk to Claude.')
  console.log('  Press Ctrl+C to stop.\n')

  launchClaude()
}

function runServe() {
  // Run cc2wx.ts directly via tsx (debug mode)
  const cc2wxTs = path.join(PKG_DIR, 'cc2wx.ts')
  const child = spawn('npx', ['tsx', cc2wxTs], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env },
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}

// --- Pre-flight checks ---

function preflight() {
  // Check Node version
  const [major] = process.versions.node.split('.').map(Number)
  if (major < 18) {
    console.error(`❌ Node.js >= 18 required (current: ${process.version})`)
    console.error('   Install: https://nodejs.org/')
    process.exit(1)
  }

  // Check Claude Code CLI
  try {
    execSync('claude --version', { stdio: 'ignore' })
  } catch {
    console.error('❌ Claude Code CLI not found')
    console.error('   Install: npm install -g @anthropic-ai/claude-code')
    console.error('   Docs: https://docs.anthropic.com/en/docs/claude-code')
    process.exit(1)
  }
}

// --- Main ---
const command = process.argv[2]

// Run preflight for commands that need Claude
if (command !== 'serve' && command !== '--help' && command !== '-h' && command !== 'help') {
  await preflight()
}

switch (command) {
  case 'login':
    runLogin()
    break
  case 'start':
    runStart()
    break
  case 'serve':
    runServe()
    break
  case '--help':
  case '-h':
  case 'help':
    console.log(HELP)
    break
  case undefined:
    // No args = default to start
    runStart()
    break
  default:
    console.error(`Unknown command: ${command}`)
    console.log()
    console.log(HELP)
    process.exit(1)
}

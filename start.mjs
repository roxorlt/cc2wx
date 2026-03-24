#!/usr/bin/env node

/**
 * cc2wx start - 启动 Claude Code + 微信 Channel
 *
 * macOS 下自动包裹 caffeinate -i 阻止空闲休眠。
 */

import { spawn } from 'node:child_process'

const claudeArgs = [
  '--dangerously-load-development-channels', 'server:cc2wx',
  '--effort', 'max',
]

const cmd = process.platform === 'darwin' ? 'caffeinate' : 'claude'
const args = process.platform === 'darwin' ? ['-i', 'claude', ...claudeArgs] : claudeArgs

const child = spawn(cmd, args, { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))

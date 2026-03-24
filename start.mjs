#!/usr/bin/env node

/**
 * cc2wx start - 启动 Claude Code + 微信 Channel
 *
 * macOS 下自动包裹 caffeinate -i 阻止空闲休眠。
 */

import { launchClaude } from './launch.mjs'

launchClaude()

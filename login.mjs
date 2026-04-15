#!/usr/bin/env node

/**
 * cc2wx login - 微信扫码登录 → 自动启动 Claude Code
 *
 * 获取 iLink Bot 登录二维码，用微信扫一扫完成授权。
 * 凭证保存到 ~/.weixin-bot/credentials.json，然后自动启动 Claude Code。
 */

import { mkdir, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import qrterm from 'qrcode-terminal'
import { launchClaude } from './launch.mjs'
import { restrictToCurrentUser } from './fs-acl.mjs'

const BASE_URL = 'https://ilinkai.weixin.qq.com'
const CRED_DIR = path.join(os.homedir(), '.weixin-bot')
const CRED_PATH = path.join(CRED_DIR, 'credentials.json')
const POLL_INTERVAL = 2000

// Step 1: Fetch QR code
console.log('正在获取登录二维码...\n')

let qrData
try {
  const qrResp = await fetch(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    signal: AbortSignal.timeout(15_000),
  })
  qrData = await qrResp.json()
} catch (err) {
  console.error(`无法连接 iLink 服务器: ${err instanceof Error ? err.message : String(err)}`)
  console.error('请检查网络连接后重试')
  process.exit(1)
}

const qrUrl = qrData.qrcode_img_content
const qrToken = qrData.qrcode

// 终端渲染二维码（与 weixin-bot SDK 示例和 openclaw-weixin 一致）
console.log('请用微信扫一扫下方二维码:\n')
qrterm.generate(qrUrl, { small: true })
console.log(`\n(也可手动复制链接在微信内打开: ${qrUrl})\n`)

// Step 2: Poll for scan status (5 minute timeout)
let lastStatus = ''
const POLL_TIMEOUT_MS = 5 * 60 * 1000
const pollStart = Date.now()

while (true) {
  if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
    console.error('等待扫码超时（5分钟），请重新运行: npx cc2wx login')
    process.exit(1)
  }

  let status
  try {
    const statusResp = await fetch(
      `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrToken)}`,
      { headers: { 'iLink-App-ClientVersion': '1' }, signal: AbortSignal.timeout(10_000) },
    )
    status = await statusResp.json()
  } catch (err) {
    console.error(`轮询状态失败: ${err instanceof Error ? err.message : String(err)}，重试中...`)
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    continue
  }

  if (status.status !== lastStatus) {
    if (status.status === 'scaned') {
      console.log('已扫码，请在微信中确认授权...')
    } else if (status.status === 'expired') {
      console.log('二维码已过期，请重新运行: npx cc2wx login')
      process.exit(1)
    }
    lastStatus = status.status
  }

  if (status.status === 'confirmed') {
    if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
      console.error('授权成功但未返回凭证，请重试')
      process.exit(1)
    }

    const credentials = {
      token: status.bot_token,
      baseUrl: status.baseurl || BASE_URL,
      accountId: status.ilink_bot_id,
      userId: status.ilink_user_id,
    }

    // Save credentials
    await mkdir(CRED_DIR, { recursive: true, mode: 0o700 })
    restrictToCurrentUser(CRED_DIR)
    await writeFile(CRED_PATH, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 })
    await chmod(CRED_PATH, 0o600)
    restrictToCurrentUser(CRED_PATH)

    console.log(`\n登录成功!`)
    console.log(`  accountId: ${credentials.accountId}`)
    console.log(`  userId:    ${credentials.userId}`)
    console.log(`  凭证已保存到 ${CRED_PATH}`)

    // 自动启动 Claude Code
    console.log('\n正在启动 Claude Code...\n')
    launchClaude()
    break
  }

  await new Promise(r => setTimeout(r, POLL_INTERVAL))
}

// Registers the webhook and the command menu of the Telegram bot (plan, section 3, steps 6 and 7).
// Usage: make telegram URL=https://public-url   (defaults to PUBLIC_URL from the env file)
//        --info: only shows the webhook, changes nothing (make telegram in dev without a running tunnel)
//        --optional-webhook: without a public URL only the command menu is updated (used by make deps)
import { BOT_COMMAND_DESCRIPTIONS, BOT_MENU_COMMANDS } from '../src/commons/constants/conversation.constant'
import { TELEGRAM_ALLOWED_UPDATES, TELEGRAM_API_URL } from '../src/commons/constants/telegram.constant'

const WEBHOOK_PATH = '/v1/telegram/webhook'

const MAX_ATTEMPTS = 5

// Retries what Telegram says is temporary: 429 (waits retry_after) and a tunnel host its DNS does not resolve yet
async function call(token: string, method: string, body: Record<string, unknown> = {}, attempt = 1): Promise<any> {
  const response = await fetch(`${TELEGRAM_API_URL}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as {
    ok: boolean
    result?: any
    description?: string
    parameters?: { retry_after?: number }
  }

  if (payload.ok) return payload.result
  const retryAfter = payload.parameters?.retry_after ?? (/resolve host/i.test(payload.description ?? '') ? 3 : null)
  if (retryAfter != null && attempt < MAX_ATTEMPTS) {
    console.log(`${method}: ${payload.description}; retrying in ${retryAfter}s (${attempt}/${MAX_ATTEMPTS - 1})`)
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
    return call(token, method, body, attempt + 1)
  }
  throw new Error(`${method} failed: ${payload.description}`)
}

async function printWebhookInfo(token: string) {
  const info = await call(token, 'getWebhookInfo')
  console.log(`Webhook: ${info.url || '(none)'}`)
  console.log(`Pending updates: ${info.pending_update_count}`)
  if (info.last_error_message) console.log(`Last error: ${info.last_error_message}`)
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  const args = process.argv.slice(2)
  const optionalWebhook = args.includes('--optional-webhook')

  if (args.includes('--info') && token) {
    await printWebhookInfo(token)
    console.log('Local bot: run pnpm dev and make tunnel (make telegram then re-registers the webhook to the tunnel)')
    return
  }
  const publicUrl = (args.find((arg) => !arg.startsWith('--')) ?? process.env.PUBLIC_URL ?? '').replace(/\/$/, '')
  const hasWebhook = Boolean(secret) && publicUrl.startsWith('https://')

  if (!token || (!hasWebhook && !optionalWebhook)) {
    throw new Error(
      'Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and an https PUBLIC_URL (or pass it as argument). ' +
        'Local bot: make tunnel · production: make telegram ENV=prod',
    )
  }

  if (hasWebhook) {
    await call(token, 'setWebhook', {
      url: `${publicUrl}${WEBHOOK_PATH}`,
      secret_token: secret,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
      drop_pending_updates: true,
    })
  } else {
    console.log('No https PUBLIC_URL: webhook left as it is (run make telegram URL=<url> once the tunnel is up)')
  }

  await call(token, 'setMyCommands', {
    // Only the groups (P18, D128): the rest work typed and sit behind their buttons
    commands: BOT_MENU_COMMANDS.map((command) => ({ command, description: BOT_COMMAND_DESCRIPTIONS[command] })),
  })

  await printWebhookInfo(token)
  console.log(`Menu: ${BOT_MENU_COMMANDS.map((command) => `/${command}`).join(' ')}`)
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})

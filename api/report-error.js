const crypto = require('crypto')

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 10
const rateLimitMap = new Map()

const ERROR_TTL_MS = 5 * 60_000
const errorCache = new Map()

// ---- Discord protection ----
let webhookDownUntil = 0
const WEBHOOK_COOLDOWN_MS = 60_000

let globalCount = 0
let globalReset = Date.now() + 60_000
const GLOBAL_MAX = 30

const LIMITS = {
    title: 120,
    desc: 1800,
    field: 900
}

// ---- Utils ----
function getIP(req) {
    return (
        req.headers['x-real-ip'] ||
        req.headers['x-forwarded-for']?.split(',')[0] ||
        req.socket?.remoteAddress ||
        'unknown'
    )
}

function isRateLimited(ip) {
    const now = Date.now()
    const entry = rateLimitMap.get(ip)

    if (!entry || entry.reset < now) {
        rateLimitMap.set(ip, { count: 1, reset: now + RATE_LIMIT_WINDOW_MS })
        return false
    }

    return ++entry.count > RATE_LIMIT_MAX
}

function globalRateLimit() {
    const now = Date.now()
    if (now > globalReset) {
        globalReset = now + 60_000
        globalCount = 0
    }
    return ++globalCount > GLOBAL_MAX
}

function sanitize(text, max) {
    if (!text) return ''
    return String(text)
        .replace(/@(everyone|here)/gi, '@\u200b$1')
        .replace(/<@[!&]?\d+>/g, '@user')
        .replace(/<#\d+>/g, '#channel')
        .slice(0, max)
}

function normalizeError(text) {
    return text
        .replace(/\b\d+\b/g, 'N')
        .replace(/\/[^\s]+/g, '/path')
        .replace(/[a-f0-9]{8,}/gi, 'hash')
        .trim()
}

function isLowQualityError(msg) {
    return ['error', 'failed', 'unknown', 'undefined']
        .includes(msg.toLowerCase().trim())
}

function generateErrorId(error, stack = '') {
    return crypto
        .createHash('sha1')
        .update(error)
        .update(stack)
        .digest('hex')
        .slice(0, 10)
}

function shouldReport(errorId) {
    const now = Date.now()
    const entry = errorCache.get(errorId)

    if (!entry || entry.expires < now) {
        errorCache.set(errorId, {
            count: 1,
            expires: now + ERROR_TTL_MS
        })
        return true
    }

    entry.count++
    return false
}

// ---- Handler ----
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') return res.end()
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    if (isRateLimited(getIP(req)) || globalRateLimit()) {
        return res.status(429).json({ error: 'Rate limit exceeded' })
    }

    if (Date.now() < webhookDownUntil) {
        return res.json({ success: false, dropped: 'webhook-down' })
    }

    const webhook = process.env.DISCORD_ERROR_WEBHOOK_URL
    if (!webhook) {
        return res.status(503).json({ error: 'Webhook not configured' })
    }

    const { error, stack, context = {} } = req.body || {}
    if (typeof error !== 'string' || error.length < 5) {
        return res.status(400).json({ error: 'Invalid payload' })
    }

    if (isLowQualityError(error)) {
        return res.json({ success: false, dropped: 'low-quality' })
    }

    const errorMsg = sanitize(error, LIMITS.desc)
    const stackMsg = sanitize(stack, LIMITS.field)

    const normalized = normalizeError(errorMsg)
    const errorId = generateErrorId(normalized, stackMsg)

    if (!shouldReport(errorId)) {
        return res.json({ success: true, errorId, deduplicated: true })
    }

    const embed = {
        title: `🔴 Bot Error • ${errorId}`.slice(0, LIMITS.title),
        description: `\`\`\`\n${errorMsg}\n\`\`\``,
        color: 0xdc143c,
        fields: [
            { name: 'Error ID', value: `\`${errorId}\``, inline: true },
            { name: 'Platform', value: sanitize(context.platform, 50) || 'unknown', inline: true },
            { name: 'Version', value: sanitize(context.version, 50) || 'unknown', inline: true }
        ],
        timestamp: new Date().toISOString()
    }

    if (stackMsg) {
        embed.fields.push({
            name: 'Stack Trace',
            value: `\`\`\`\n${stackMsg}\n\`\`\``
        })
    }

    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 2500)

        await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'Microsoft Rewards Bot',
                embeds: [embed]
            }),
            signal: controller.signal
        })

        clearTimeout(timeout)

    } catch {
        webhookDownUntil = Date.now() + WEBHOOK_COOLDOWN_MS
    }

    return res.json({ success: true, errorId })
}

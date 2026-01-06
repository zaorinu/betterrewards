const crypto = require('crypto')

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 10
const rateLimitMap = new Map()

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

    if (++entry.count > RATE_LIMIT_MAX) return true
    return false
}

function sanitize(text, max) {
    if (!text) return ''
    return String(text)
        .replace(/@(everyone|here)/gi, '@\u200b$1')
        .replace(/<@[!&]?\d+>/g, '@user')
        .replace(/<#\d+>/g, '#channel')
        .slice(0, max)
}

function generateErrorId(error, stack = '') {
    return crypto
        .createHash('sha1')
        .update(error)
        .update(stack)
        .digest('hex')
        .slice(0, 10)
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') return res.end()
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    const ip = getIP(req)
    if (isRateLimited(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded' })
    }

    const webhook = process.env.DISCORD_ERROR_WEBHOOK_URL
    if (!webhook) {
        return res.status(503).json({ error: 'Webhook not configured' })
    }

    const { error, stack, context = {} } = req.body || {}
    if (typeof error !== 'string') {
        return res.status(400).json({ error: 'Invalid payload' })
    }

    const errorMsg = sanitize(error, 1900)
    const stackMsg = sanitize(stack, 1000)

    const errorId = generateErrorId(errorMsg, stackMsg)

    const embed = {
        title: `🔴 Bot Error • ${errorId}`,
        description: `\`\`\`\n${errorMsg}\n\`\`\``,
        color: 0xdc143c,
        fields: [
            { name: 'Error ID', value: `\`${errorId}\``, inline: true },
            { name: 'Version', value: sanitize(context.version, 50) || 'unknown', inline: true },
            { name: 'Platform', value: sanitize(context.platform, 50) || 'unknown', inline: true }
        ],
        timestamp: new Date().toISOString()
    }

    if (stackMsg) {
        embed.fields.push({
            name: 'Stack Trace',
            value: `\`\`\`\n${stackMsg}\n\`\`\``
        })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

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

    return res.json({ success: true, errorId })
}

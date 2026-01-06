// Constants
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 10
const rateLimitMap = new Map()

// ---- Utils ----
function getIP(req) {
    return (
        req.headers['x-real-ip'] ||
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
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

    if (entry.count >= RATE_LIMIT_MAX) return true
    entry.count++
    return false
}

function sanitize(text, max = 2000) {
    if (!text) return ''

    return String(text)
        .replace(/@(everyone|here)/gi, '@\u200b$1')
        .replace(/<@[!&]?\d+>/g, '@user')
        .replace(/<#\d+>/g, '#channel')
        .slice(0, max)
}

// ---- Handler ----
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') return res.status(200).end()
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    try {
        const ip = getIP(req)
        if (isRateLimited(ip)) {
            return res.status(429).json({ error: 'Rate limit exceeded' })
        }

        const webhook = process.env.DISCORD_ERROR_WEBHOOK_URL
        if (!webhook) {
            return res.status(503).json({ error: 'Webhook not configured' })
        }

        const body = req.body
        if (!body?.error || typeof body.error !== 'string') {
            return res.status(400).json({ error: 'Invalid payload' })
        }

        // Normalize & sanitize
        const errorMsg = sanitize(body.error, 1900)
        const stack = sanitize(body.stack, 1000)
        const ctx = body.context || {}

        const embed = {
            title: '🔴 Bot Error Report',
            description: `\`\`\`\n${errorMsg}\n\`\`\``,
            color: 0xdc143c,
            fields: [
                { name: 'Version', value: sanitize(ctx.version || 'unknown', 50), inline: true },
                { name: 'Platform', value: sanitize(ctx.platform || 'unknown', 50), inline: true },
                { name: 'Node', value: sanitize(ctx.nodeVersion || 'unknown', 50), inline: true }
            ],
            timestamp: new Date().toISOString()
        }

        if (stack) {
            embed.fields.push({
                name: 'Stack Trace',
                value: `\`\`\`\n${stack}\n\`\`\``
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

        return res.json({ success: true })

    } catch (err) {
        console.error('[ErrorReporting]', err)
        return res.status(500).json({
            error: 'Failed to report error'
        })
    }
}

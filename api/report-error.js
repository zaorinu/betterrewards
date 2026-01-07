const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

/* ================= SUPABASE ================= */

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function isFirstError(errorId, normalized) {
    const { error } = await supabase
        .from('error_events')
        .insert({
            error_id: errorId,
            normalized_error: normalized
        })

    // error already exists
    if (error) {
        if (error.code === '23505') return false
        throw error
    }

    return true
}

/* ================= AUTH ================= */

const MAX_CLOCK_SKEW = 30_000

function verifyAuthorization(auth) {
    if (!auth || !auth.startsWith('Bearer ')) return false

    let decoded
    try {
        decoded = Buffer.from(auth.slice(7), 'base64').toString()
    } catch {
        return false
    }

    const [clientId, expStr, signature] = decoded.split('.')
    const exp = Number(expStr)

    if (!clientId || !exp || !signature) return false
    if (Date.now() > exp + MAX_CLOCK_SKEW) return false

    const expected = crypto
        .createHmac('sha256', process.env.AUTH_MASTER_SECRET)
        .update(`${clientId}.${exp}`)
        .digest('hex')

    try {
        return crypto.timingSafeEqual(
            Buffer.from(expected),
            Buffer.from(signature)
        )
    } catch {
        return false
    }
}

/* ================= RATE LIMIT ================= */

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 10
const rateLimitMap = new Map()

let globalCount = 0
let globalReset = Date.now() + 60_000
const GLOBAL_MAX = 30

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

/* ================= UTILS ================= */

const LIMITS = {
    title: 120,
    desc: 1800,
    field: 900
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
        .replace(/\[[^\]]+]/g, '')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'user')
        .replace(/\b[a-z0-9]{1,3}\*+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, 'user')
        .replace(/\b\d+\b/g, 'N')
        .replace(/[a-f0-9]{8,}/gi, 'hash')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
}

function generateErrorId(normalized) {
    return crypto
        .createHash('sha1')
        .update(normalized)
        .digest('hex')
        .slice(0, 10)
}

/* ================= HANDLER ================= */

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') return res.end()
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    if (!verifyAuthorization(req.headers.authorization)) {
        return res.status(401).json({ error: 'Unauthorized' })
    }

    if (isRateLimited(getIP(req)) || globalRateLimit()) {
        return res.status(429).json({ error: 'Rate limit exceeded' })
    }

    const webhook = process.env.DISCORD_ERROR_WEBHOOK_URL
    if (!webhook) {
        return res.status(503).json({ error: 'Webhook not configured' })
    }

    const { error, stack, context = {} } = req.body || {}
    if (typeof error !== 'string' || error.length < 5) {
        return res.status(400).json({ error: 'Invalid payload' })
    }

    const errorMsg = sanitize(error, LIMITS.desc)
    const stackMsg = sanitize(stack, LIMITS.field)

    const normalized = normalizeError(errorMsg)
    const errorId = generateErrorId(normalized)

    let firstOccurrence = false
    try {
        firstOccurrence = await isFirstError(errorId, normalized)
    } catch (e) {
        console.error('Supabase error:', e)
    }

    // ⛔ erro já conhecido → não envia webhook
    if (!firstOccurrence) {
        return res.json({ success: true, errorId, deduplicated: true })
    }

    /* ===== WEBHOOK (aparência ANTIGA) ===== */

    const embed = {
        title: `🔴 Error Report • ${errorId}`.slice(0, LIMITS.title),
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

    await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: 'Microsoft Rewards Bot',
            content: `-# ${errorId}`,
            embeds: [embed]
        })
    })

    return res.json({ success: true, errorId })
}

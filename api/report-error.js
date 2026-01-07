const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

/* ================= SUPABASE ================= */

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function registerError(errorId, normalized) {
    const { data, error } = await supabase
        .from('error_events')
        .upsert({
            error_id: errorId,
            normalized_error: normalized,
            last_seen: new Date().toISOString()
        }, { onConflict: 'error_id' })
        .select('count')
        .single()

    if (error) throw error

    await supabase
        .from('error_events')
        .update({
            count: data.count + 1,
            last_seen: new Date().toISOString()
        })
        .eq('error_id', errorId)

    return data.count + 1
}

/* ================= AUTH ================= */

const MAX_CLOCK_SKEW = 30_000

function verifyAuthorization(auth) {
    if (!auth || !auth.startsWith('Bearer ')) return false
    let decoded
    try {
        decoded = Buffer.from(auth.slice(7), 'base64').toString()
    } catch { return false }

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
    } catch { return false }
}

/* ================= RATE LIMIT ================= */

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 10
const rateLimitMap = new Map()

const ERROR_TTL_MS = 5 * 60_000
const errorCache = new Map()

let webhookDownUntil = 0
const WEBHOOK_COOLDOWN_MS = 60_000

let globalCount = 0
let globalReset = Date.now() + 60_000
const GLOBAL_MAX = 30

/* ================= UTILS ================= */

function getIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]
        || req.socket?.remoteAddress
        || 'unknown'
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

function normalizeError(text) {
    return text
        .replace(/\[[^\]]+]/g, '')
        .replace(/\b\d+\b/g, 'N')
        .replace(/[a-f0-9]{8,}/gi, 'hash')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
}

function generateErrorId(text) {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)
}

function shouldReport(errorId) {
    const now = Date.now()
    const entry = errorCache.get(errorId)
    if (!entry || entry.expires < now) {
        errorCache.set(errorId, { expires: now + ERROR_TTL_MS })
        return true
    }
    return false
}

/* ================= HANDLER ================= */

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    if (!verifyAuthorization(req.headers.authorization)) {
        return res.status(401).json({ error: 'Unauthorized' })
    }

    if (isRateLimited(getIP(req)) || globalRateLimit()) {
        return res.status(429).json({ error: 'Rate limit exceeded' })
    }

    if (Date.now() < webhookDownUntil) {
        return res.json({ success: false, dropped: 'webhook-down' })
    }

    const { error } = req.body || {}
    if (typeof error !== 'string' || error.length < 5) {
        return res.status(400).json({ error: 'Invalid payload' })
    }

    const normalized = normalizeError(error)
    const errorId = generateErrorId(normalized)

    let count = 1
    try {
        count = await registerError(errorId, normalized)
    } catch (e) {
        console.error('Supabase error:', e)
    }

    if (!shouldReport(errorId)) {
        return res.json({ success: true, errorId, deduplicated: true, count })
    }

    try {
        await fetch(process.env.DISCORD_ERROR_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `🔴 **Error ${errorId}**\nOcorrências: **${count}**\n\`\`\`${error}\`\`\``
            })
        })
    } catch {
        webhookDownUntil = Date.now() + WEBHOOK_COOLDOWN_MS
    }

    return res.json({ success: true, errorId, count })
}

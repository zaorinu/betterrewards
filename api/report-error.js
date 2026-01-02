const axios = require('axios')

// In-memory rate limiting for error reporting
const rateLimitMap = new Map()
const RATE_LIMIT_WINDOW_MS = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10

function isRateLimited(ip) {
    const now = Date.now()
    const record = rateLimitMap.get(ip)

    if (!record || now > record.resetTime) {
        rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS })
        return false
    }

    if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
        return true
    }

    record.count++
    return false
}

// Sanitize text to prevent Discord mention abuse
function sanitizeDiscordText(text) {
    if (!text) return ''

    return String(text)
        // Remove @everyone and @here mentions
        .replace(/@(everyone|here)/gi, '@\u200b$1')
        // Remove user mentions <@123456>
        .replace(/<@!?(\d+)>/g, '@user')
        // Remove role mentions <@&123456>
        .replace(/<@&(\d+)>/g, '@role')
        // Remove channel mentions <#123456>
        .replace(/<#(\d+)>/g, '#channel')
        // Limit length
        .slice(0, 2000)
}

// Vercel serverless handler
module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end()
    }

    // Only POST allowed
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    try {
        // Rate limiting
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown'
        if (isRateLimited(ip)) {
            return res.status(429).json({ error: 'Rate limit exceeded' })
        }

        // Check Discord webhook URL
        const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK_URL
        if (!webhookUrl) {
            console.error('[ErrorReporting] DISCORD_ERROR_WEBHOOK_URL not configured')
            return res.status(503).json({ error: 'Error reporting service unavailable' })
        }

        // Validate payload
        const payload = req.body
        if (!payload?.error) {
            return res.status(400).json({ error: 'Invalid payload: missing error field' })
        }

        // Sanitize all text fields to prevent Discord mention abuse
        const sanitizedError = sanitizeDiscordText(payload.error)
        const sanitizedStack = payload.stack ? sanitizeDiscordText(payload.stack) : null
        const sanitizedVersion = sanitizeDiscordText(payload.context?.version || 'unknown')
        const sanitizedPlatform = sanitizeDiscordText(payload.context?.platform || 'unknown')
        const sanitizedNode = sanitizeDiscordText(payload.context?.nodeVersion || 'unknown')

        // Build Discord embed
        const embed = {
            title: '🔴 Bot Error Report',
            description: `\`\`\`\n${sanitizedError.slice(0, 1900)}\n\`\`\``,
            color: 0xdc143c,
            fields: [
                { name: 'Version', value: sanitizedVersion, inline: true },
                { name: 'Platform', value: sanitizedPlatform, inline: true },
                { name: 'Node', value: sanitizedNode, inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'Community Error Reporting' }
        }

        if (sanitizedStack) {
            const stackLines = sanitizedStack.split('\n').slice(0, 15).join('\n')
            embed.fields.push({
                name: 'Stack Trace',
                value: `\`\`\`\n${stackLines.slice(0, 1000)}\n\`\`\``,
                inline: false
            })
        }

        // Send to Discord
        await axios.post(webhookUrl, {
            username: 'Microsoft Rewards Bot',
            avatar_url: 'https://raw.githubusercontent.com/LightZirconite/Microsoft-Rewards-Bot/refs/heads/main/assets/logo.png',
            embeds: [embed]
        }, { timeout: 10000 })

        console.log('[ErrorReporting] Report sent successfully')
        return res.json({ success: true, message: 'Error report received' })

    } catch (error) {
        console.error('[ErrorReporting] Failed:', error)
        return res.status(500).json({
            error: 'Failed to send error report',
            message: error.message || 'Unknown error'
        })
    }
}

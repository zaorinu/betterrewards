// Cors headers
res.setHeader('Access-Control-Allow-Origin', '*')
res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

// register.js
const crypto = require('crypto')

const TOKEN_TTL_MS = 60 * 60_000 // 1 hora

module.exports = function register(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    const master = process.env.AUTH_MASTER_SECRET
    if (!master) {
        return res.status(500).json({ error: 'Master secret not configured' })
    }

    const clientId = crypto.randomBytes(8).toString('hex')
    const exp = Date.now() + TOKEN_TTL_MS

    const payload = `${clientId}.${exp}`

    const signature = crypto
        .createHmac('sha256', master)
        .update(payload)
        .digest('hex')

    const token = Buffer
        .from(`${payload}.${signature}`)
        .toString('base64')

    return res.json({
        authorization: `Bearer ${token}`,
        expiresAt: exp
    })
}

import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { DISCORD } from '../../constants'
import { Config } from '../../interface/Config'

interface ErrorReportPayload {
    error: string
    stack?: string
    context: {
        version: string
        platform: string
        arch: string
        nodeVersion: string
        timestamp: string
        botMode?: string  // DESKTOP, MOBILE, or MAIN
    }
}

/**
 * Simple obfuscation/deobfuscation for webhook URL
 * Not for security, just to avoid easy scraping
 */
export function obfuscateWebhookUrl(url: string): string {
    return Buffer.from(url).toString('base64')
}

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function deobfuscateWebhookUrl(encoded: string): string {
    const trimmed = encoded.trim()
    if (!trimmed || !BASE64_REGEX.test(trimmed)) {
        return ''
    }

    try {
        return Buffer.from(trimmed, 'base64').toString('utf-8')
    } catch {
        return ''
    }
}

/**
 * Check if an error should be reported (filter false positives and user configuration errors)
 */
function shouldReportError(errorMessage: string): boolean {
    const lowerMessage = errorMessage.toLowerCase()

    // List of patterns that indicate user configuration errors (not reportable bugs)
    const userConfigPatterns = [
        /accounts\.jsonc.*not found/i,
        /config\.jsonc.*not found/i,
        /invalid.*credentials/i,
        /login.*failed/i,
        /authentication.*failed/i,
        /proxy.*connection.*failed/i,
        /totp.*invalid/i,
        /2fa.*failed/i,
        /incorrect.*password/i,
        /account.*suspended/i,
        /account.*banned/i,
        /no.*accounts.*enabled/i,
        /invalid.*configuration/i,
        /missing.*required.*field/i,
        /port.*already.*in.*use/i,
        /eaddrinuse/i,
        // Rebrowser-playwright expected errors (benign, non-fatal)
        /rebrowser-patches.*cannot get world/i,
        /session closed.*rebrowser/i,
        /addScriptToEvaluateOnNewDocument.*session closed/i,
        // User auth issues (not bot bugs)
        /password.*incorrect/i,
        /email.*not.*found/i,
        /account.*locked/i
    ]

    // Don't report user configuration errors
    for (const pattern of userConfigPatterns) {
        if (pattern.test(lowerMessage)) {
            return false
        }
    }

    // List of patterns that indicate expected/handled errors (not bugs)
    const expectedErrorPatterns = [
        /no.*points.*to.*earn/i,
        /already.*completed/i,
        /activity.*not.*available/i,
        /daily.*limit.*reached/i,
        /quest.*not.*found/i,
        /promotion.*expired/i,
        // Playwright expected errors (page lifecycle, navigation, timeouts)
        /target page.*context.*browser.*been closed/i,
        /page.*has been closed/i,
        /context.*has been closed/i,
        /browser.*has been closed/i,
        /execution context was destroyed/i,
        /frame was detached/i,
        /navigation.*cancelled/i,
        /timeout.*exceeded/i,
        /waiting.*failed.*timeout/i,
        /net::ERR_ABORTED/i,
        /net::ERR_CONNECTION_REFUSED/i,
        /net::ERR_NAME_NOT_RESOLVED/i
    ]

    // Don't report expected/handled errors
    for (const pattern of expectedErrorPatterns) {
        if (pattern.test(lowerMessage)) {
            return false
        }
    }

    // Report everything else (genuine bugs)
    return true
}

// Hardcoded webhook URL for error reporting (obfuscated)
// This webhook receives anonymized error reports to help improve the project
const ERROR_WEBHOOK_URL = 'aHR0cHM6Ly9kaXNjb3JkLmNvbS9hcGkvd2ViaG9va3MvMTQ1MDU3NDQ4OTgwNDA4MzIzNC9SVGFQYXluNktVSUQtb2o2NVVQWHVrb2tpRXY1blJsdlJHc2R4MGZfVVZRMkJlN0hlOXc1bWxQb3lRQUV4OHlkc3Q4cA=='

// Track disabled webhook URLs during this execution (in-memory, not persistent)
// Used to disable error reporting temporarily if webhook is deleted (404)
const disabledWebhookUrls = new Set<string>()

/**
 * Disable error reporting temporarily for this execution
 * Used when webhook is deleted (404) - no need to keep trying
 */
export function disableErrorReportingTemporary(): void {
    const webhookUrl = deobfuscateWebhookUrl(ERROR_WEBHOOK_URL)
    if (webhookUrl) {
        disabledWebhookUrls.add(webhookUrl)
        process.stderr.write('[ErrorReporting] ⚠️ Disabled temporarily for this execution (webhook no longer available)\n')
    }
}

/**
 * Send error report to Discord webhook for community contribution
 * Only sends non-sensitive error information to help improve the project
 */
export async function sendErrorReport(
    config: Config,
    error: Error | string,
    additionalContext?: Record<string, unknown>
): Promise<void> {
    // Check if error reporting is enabled
    if (config.errorReporting?.enabled === false) {
        process.stderr.write('[ErrorReporting] Disabled in config (errorReporting.enabled = false)\n')
        return
    }

    // Log that error reporting is enabled
    process.stderr.write('[ErrorReporting] Enabled, processing error...\n')

    try {
        // Deobfuscate webhook URL
        const webhookUrl = deobfuscateWebhookUrl(ERROR_WEBHOOK_URL)
        if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
            process.stderr.write('[ErrorReporting] Invalid webhook URL after deobfuscation\n')
            return
        }

        // Check if webhook was disabled during this execution (404 or similar)
        if (disabledWebhookUrls.has(webhookUrl)) {
            process.stderr.write('[ErrorReporting] Temporarily disabled (webhook not available - was it deleted?)\n')
            return
        }

        const errorMessage = error instanceof Error ? error.message : String(error)

        // Filter out false positives and user configuration errors
        if (!shouldReportError(errorMessage)) {
            process.stderr.write(`[ErrorReporting] Filtered error (expected/benign): ${errorMessage.substring(0, 100)}\n`)
            return
        }

        process.stderr.write(`[ErrorReporting] Sending error report: ${errorMessage.substring(0, 100)}\n`)
        const errorStack = error instanceof Error ? error.stack : undefined

        // Sanitize error message and stack - remove any potential sensitive data
        const sanitize = (text: string): string => {
            return text
                // Remove email addresses
                .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL_REDACTED]')
                // Remove absolute paths (Windows and Unix)
                .replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, '[PATH_REDACTED]')
                .replace(/\/(?:home|Users)\/[^/\s]+(?:\/[^/\s]+)*/g, '[PATH_REDACTED]')
                // Remove IP addresses
                .replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, '[IP_REDACTED]')
                // Remove potential tokens/keys (sequences of 20+ alphanumeric chars)
                .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[TOKEN_REDACTED]')
        }

        const sanitizedMessage = sanitize(errorMessage)
        const sanitizedStack = errorStack ? sanitize(errorStack).split('\n').slice(0, 10).join('\n') : undefined

        // Build context payload with system information
        const payload: ErrorReportPayload = {
            error: sanitizedMessage,
            stack: sanitizedStack,
            context: {
                version: getProjectVersion(),
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
                timestamp: new Date().toISOString(),
                // IMPROVED: Extract bot mode from additionalContext before sanitization
                botMode: (additionalContext?.platform as string) || 'UNKNOWN'
            }
        }

        // Add additional context if provided (also sanitized)
        if (additionalContext) {
            const sanitizedContext: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(additionalContext)) {
                if (typeof value === 'string') {
                    sanitizedContext[key] = sanitize(value)
                } else {
                    sanitizedContext[key] = value
                }
            }
            Object.assign(payload.context, sanitizedContext)
        }

        // Detect Docker environment
        const isDockerEnv = (() => {
            try {
                return fs.existsSync('/.dockerenv') ||
                    (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'))
            } catch {
                return false
            }
        })()

        // Format OS platform display
        const osPlatform = (() => {
            if (isDockerEnv) return '🐳 Docker'
            switch (payload.context.platform) {
                case 'win32': return '🪟 Windows'
                case 'darwin': return '🍎 macOS'
                case 'linux': return '🐧 Linux'
                default: return payload.context.platform
            }
        })()

        // Build Discord embed with improved formatting
        const embed = {
            title: '🐛 Automatic Error Report',
            description: `\`\`\`js\n${sanitizedMessage.slice(0, 700)}\n\`\`\``,
            color: DISCORD.COLOR_RED,
            fields: [
                {
                    name: '📦 Version',
                    value: payload.context.version === 'unknown' ? '⚠️ Unknown (check package.json)' : `v${payload.context.version}`,
                    inline: true
                },
                {
                    name: '🤖 Bot Mode',
                    value: payload.context.botMode || 'UNKNOWN',
                    inline: true
                },
                {
                    name: '💻 OS Platform',
                    value: `${osPlatform} ${payload.context.arch}`,
                    inline: true
                },
                {
                    name: '⚙️ Node.js',
                    value: payload.context.nodeVersion,
                    inline: true
                },
                {
                    name: '🕐 Timestamp',
                    value: new Date(payload.context.timestamp).toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' }),
                    inline: false
                }
            ],
            timestamp: payload.context.timestamp,
            footer: {
                text: 'Automatic error reporting • Non-sensitive data only',
                icon_url: DISCORD.AVATAR_URL
            }
        }

        // Add stack trace field if available (truncated to fit Discord limits)
        if (sanitizedStack) {
            // Limit to 900 chars to leave room for backticks and formatting
            const truncated = sanitizedStack.slice(0, 900)
            const wasTruncated = sanitizedStack.length > 900

            embed.fields.push({
                name: '📋 Stack Trace' + (wasTruncated ? ' (truncated for display)' : ''),
                value: `\`\`\`js\n${truncated}${wasTruncated ? '\n... (see full trace in logs)' : ''}\n\`\`\``,
                inline: false
            })
        }

        // Add additional context fields if provided
        if (additionalContext) {
            for (const [key, value] of Object.entries(additionalContext)) {
                if (embed.fields.length < 25) { // Discord limit
                    embed.fields.push({
                        name: key,
                        value: String(value).slice(0, 1024),
                        inline: true
                    })
                }
            }
        }

        const discordPayload = {
            username: 'Microsoft-Rewards-Bot Error Reporter',
            avatar_url: DISCORD.AVATAR_URL,
            embeds: [embed]
        }

        // Send to webhook with timeout
        const response = await axios.post(webhookUrl, discordPayload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        })

        process.stderr.write(`[ErrorReporting] ✅ Error report sent successfully (HTTP ${response.status})\n`)
    } catch (webhookError) {
        // Enhanced error handling - detect specific HTTP errors
        let errorMsg = ''
        let httpStatus: number | null = null

        if (webhookError && typeof webhookError === 'object' && 'response' in webhookError) {
            const axiosError = webhookError as { response?: { status: number } }
            httpStatus = axiosError.response?.status || null
        }

        // Handle specific error cases
        if (httpStatus === 404) {
            // Webhook was deleted - disable error reporting for this execution
            errorMsg = 'Webhook not found (404) - was it deleted? Disabling error reporting for this run.'
            disableErrorReportingTemporary()
            process.stderr.write(`[ErrorReporting] ❌ ${errorMsg}\n`)
            return
        }

        if (httpStatus === 401 || httpStatus === 403) {
            // Authentication/authorization error
            errorMsg = `Webhook authentication failed (HTTP ${httpStatus}) - check if webhook token is valid`
            disableErrorReportingTemporary()
            process.stderr.write(`[ErrorReporting] ❌ ${errorMsg}\n`)
            return
        }

        if (httpStatus && httpStatus >= 500) {
            // Server error - may be temporary, log but don't disable
            errorMsg = `Discord server error (HTTP ${httpStatus}) - will retry on next error`
            process.stderr.write(`[ErrorReporting] ⚠️ ${errorMsg}\n`)
            return
        }

        // Generic error message
        if (!errorMsg) {
            errorMsg = webhookError instanceof Error ? webhookError.message : String(webhookError)
        }

        // Log detailed error for debugging
        process.stderr.write(`[ErrorReporting] ❌ Failed to send error report: ${errorMsg}\n`)

        // If it's a network error, provide additional context
        if (webhookError instanceof Error && (webhookError.message.includes('ENOTFOUND') || webhookError.message.includes('ECONNREFUSED'))) {
            process.stderr.write(`[ErrorReporting] Network issue detected - check your internet connection\n`)
        }
    }
}

/**
 * Get project version from package.json
 * FIXED: Use path.join to correctly resolve package.json location in both dev and production
 */
function getProjectVersion(): string {
    try {
        // Try multiple possible paths (dev and compiled)
        const possiblePaths = [
            path.join(__dirname, '../../../package.json'),  // From dist/util/notifications/
            path.join(__dirname, '../../package.json'),     // From src/util/notifications/
            path.join(process.cwd(), 'package.json')        // From project root
        ]

        for (const pkgPath of possiblePaths) {
            try {
                if (fs.existsSync(pkgPath)) {
                    const raw = fs.readFileSync(pkgPath, 'utf-8')
                    const pkg = JSON.parse(raw) as { version?: string }
                    if (pkg.version) {
                        return pkg.version
                    }
                }
            } catch {
                // Try next path
                continue
            }
        }

        return 'unknown'
    } catch {
        return 'unknown'
    }
}

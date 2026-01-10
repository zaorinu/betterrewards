import chalk from 'chalk'
import { logEventEmitter } from '../util/notifications/Logger'
import { sendErrorReport } from '../util/notifications/ErrorReportingWebhook'

type LogEntry = { timestamp: string; level: string; platform: string; title: string; message: string }

const PINK = chalk.hex('#ff66cc')

let logs: string[] = []
let showingLogs = false // Start with main screen, not logs
let interval: NodeJS.Timeout | null = null
let uiActive = false
let startTime = Date.now()
let version = 'v?' 
let accountDisplay: string | undefined = undefined
let getCurrentAccount: (() => string | undefined) | undefined = undefined
let config: any = null
let errorIDs: string[] = []

function partialAccount(s: string | undefined): string {
    if (!s) return 'No account selected'
    if (s === '***hidden***') return 'Account hidden'
    const at = s.indexOf('@')
    if (at === -1) return s.slice(0, 3) + (s.length > 3 ? '***' : '')
    const user = s.slice(0, at)
    const domain = s.slice(at + 1)
    if (user.length <= 2) return `***@${domain}`
    const visible = user.slice(-2)
    return `***${visible}@${domain}`
}
let lastDraw = ''
let logOffset = 0 // 0 = follow tail

function centerLines(lines: string[], cols: number, rows: number) {
    const out: string[] = []
    const blockHeight = lines.length

    // If content taller than terminal, show the top-most portion (avoid excessive scrolling)
    if (blockHeight >= rows) {
        for (let i = 0; i < rows; i++) {
            const raw = lines[i] ?? ''
            const vis = truncateVisible(raw, cols)
            const pad = Math.max(0, Math.floor((cols - vis.length) / 2))
            out.push(' '.repeat(pad) + vis)
        }
        return out
    }

    const top = Math.max(0, Math.floor((rows - blockHeight) / 2))
    for (let i = 0; i < top; i++) out.push('')
    for (const l of lines) {
        const raw = l ?? ''
        const vis = truncateVisible(raw, cols)
        const pad = Math.max(0, Math.floor((cols - vis.length) / 2))
        out.push(' '.repeat(pad) + vis)
    }
    return out
}

function stripAnsi(s: string) {
    return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

function truncateVisible(s: string, max: number) {
    const visible = stripAnsi(s)
    if (visible.length <= max) return visible
    return visible.slice(0, Math.max(0, max - 1))
}

function formatMainScreen(): string {
    const rows = process.stdout.rows || 24

    const elapsed = formatElapsed(Date.now() - startTime)

    let statusLine: string
    if (accountDisplay === undefined) {
        statusLine = '  Loading profiles...'
    } else {
        const accountText = partialAccount(accountDisplay)
        statusLine = `  Farming points on account ${accountText}`
    }

    const banner = [
        ' ',
        ' ',
        ' ',
        ' d8888b  88bd88b d8888b d888b8b    88bd8b,d88b ',
        "d8P' `P  88P'  `d8b_,dPd8P' ?88    88P'`?8P'?8b",
        '88b     d88     88b    88b  ,88b  d88  d88  88P',
        "`?888P'd88'     `?888P'`?88P'`88bd88' d88'  88b",
        ' ',
        statusLine,
        ' ',
        `   Run time: [${elapsed}]`,
        `   Version: ${version}`,
        ' ',
        ' ',
    ]

    const centered = centerLines(banner, process.stdout.columns || 80, rows)
    const pinkLines = centered.map(l => PINK(l))
    return '\x1b[2J\x1b[H' + pinkLines.join('\n')
}

function formatLogsScreen(): string {
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    const avail = Math.max(3, rows - 4) // leave space for header/separators
    const total = logs.length
    const start = Math.max(0, total - avail - logOffset)
    const slice = logs.slice(start, start + avail)

    const headerText = logOffset > 0 ? `-- LOGS (paused: +${logOffset}) --` : `-- LOGS (live) --`
    const sep = '-'.repeat(Math.min(50, cols))

    const lines: string[] = []
    lines.push(PINK(headerText))
    lines.push(PINK(sep))

    for (const l of slice) {
        lines.push(truncateVisible(l, cols))
    }

    lines.push(PINK(sep))

    return '\x1b[2J\x1b[H' + lines.join('\n')
}

function formatElapsed(ms: number) {
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

function pad(n: number) { return String(n).padStart(2, '0') }

function draw() {
    if (!uiActive) return
    try {
        const out = showingLogs ? formatLogsScreen() : formatMainScreen()
        if (out !== lastDraw) {
            process.stdout.write(out)
            lastDraw = out
        }
    } catch { /* ignore */ }
}

function onLog(e: LogEntry) {
    const line = `[${new Date(e.timestamp).toLocaleString()}] [${e.platform}] ${e.level.toUpperCase()} [${e.title}] ${e.message}`
    logs.push(line)
    if (logs.length > 500) logs.shift()

    // Error reporting for SimpleUI
    if (e.level === 'error' && config) {
        const errorObj = new Error(line)
        void (async () => {
            try {
                const id = await sendErrorReport(config, errorObj, {
                    title: e.title,
                    platform: e.platform
                })
                if (id) {
                    errorIDs.push(id)
                }
            } catch (reportError) {
                // Non-critical: silently ignore reporting errors
            }
        })()
    }
}

export function startUI(opts: { versionStr?: string; account?: string | undefined; config?: any; getCurrentAccount?: () => string | undefined } = {}) {
    if (uiActive) {
        // UI já ativo, só atualizar config e getCurrentAccount se fornecidos
        if (opts.config) config = opts.config
        if (opts.getCurrentAccount) getCurrentAccount = opts.getCurrentAccount
        return
    }
    uiActive = true
    startTime = Date.now()
    if (opts.versionStr) version = opts.versionStr
    // Do not set accountDisplay here to avoid overwriting detected accounts
    if (opts.config) config = opts.config
    if (opts.getCurrentAccount) getCurrentAccount = opts.getCurrentAccount

    // Enter alternate screen and hide cursor to avoid polluting scrollback
    try { process.stdout.write('\x1B[?1049h') } catch { }
    process.stdout.write('\x1B[?25l')

    // Subscribe to logs
    logEventEmitter.on('log', onLog)

    // Start periodic draw for clock updates
    interval = setInterval(() => {
        if (uiActive) {
            const newAccount = getCurrentAccount ? getCurrentAccount() : undefined
            if (newAccount && !accountDisplay) {
                accountDisplay = newAccount
            }
            draw()
        }
    }, 1000) // Update every second

    // Initial draw
    draw()

    // Handle exit to show error summary
    process.on('exit', (code) => {
        if (code !== 0 && uiActive) {
            stopUI()
        }
    })

    // Key handler
    if (process.stdin && process.stdin.setRawMode) {
        process.stdin.setRawMode(true)
        process.stdin.resume()
        process.stdin.on('data', (chunk: Buffer) => {
            const s = chunk.toString()

            // Toggle logs with L
            if (s === 'l' || s === 'L') {
                showingLogs = !showingLogs
                logOffset = 0
                lastDraw = ''
                draw()
                return
            }

            // Quit UI with Q
            if (s === 'q' || s === 'Q') {
                stopUI()
                return
            }

            // Arrow keys and page up/down for log scrolling
            if (showingLogs) {
                if (s === '\u001b[A') { // up
                    logOffset = Math.min(logs.length - 1, logOffset + 1)
                    lastDraw = ''
                    draw()
                    return
                }
                if (s === '\u001b[B') { // down
                    logOffset = Math.max(0, logOffset - 1)
                    lastDraw = ''
                    draw()
                    return
                }
                if (s === '\u001b[5~') { // PageUp
                    logOffset = Math.min(logs.length - 1, logOffset + 10)
                    lastDraw = ''
                    draw()
                    return
                }
                if (s === '\u001b[6~') { // PageDown
                    logOffset = Math.max(0, logOffset - 10)
                    lastDraw = ''
                    draw()
                    return
                }
            }

            // Allow Ctrl-C to behave normally
            if (chunk.length === 1 && chunk[0] === 3) {
                stopUI()
                process.exit()
            }
        })
    }
}

export function stopUI() {
    if (!uiActive) return
    uiActive = false
    if (interval) { clearInterval(interval); interval = null }
    logEventEmitter.removeListener('log', onLog)
    // Restore cursor and exit alternate screen
    process.stdout.write('\x1B[?25h')
    try { process.stdout.write('\x1B[?1049l') } catch { }
    try { process.stdin.setRawMode(false) } catch { }

    // Small message to inform the user that the UI closed and logs will continue normally
    if (errorIDs.length > 0) {
        try { 
            console.log(`\nDetected ${errorIDs.length} critical error(s) during session.`)
            console.log(`Error IDs: ${errorIDs.join(', ')}`)
            console.log('Please report these IDs for support.\n')
        } catch { }
    } else {
        try { console.log('\nEasy UI closed. Logs will continue to STDOUT.\n') } catch { }
    }
}

// Ensure we export for integration
export default { startUI, stopUI }

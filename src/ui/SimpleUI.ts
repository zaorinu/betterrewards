import chalk from 'chalk'
import { logEventEmitter } from '../util/notifications/Logger'
import { sendErrorReport } from '../util/notifications/ErrorReportingWebhook'

type LogEntry = {
    timestamp: string
    level: string
    platform: string
    title: string
    message: string
}

const PINK = chalk.hex('#ff66cc')

let logs: string[] = []
let showingLogs = false
let interval: NodeJS.Timeout | null = null
let uiActive = false
let startTime = Date.now()
let version = 'v?'
let config: any = null
let errorIDs: string[] = []

// ✅ FINAL, IMUTÁVEL
let activeAccounts: string[] = []

/* ===================== UTIL ===================== */

function partialAccount(s: string): string {
    if (s === '***hidden***') return 'Account hidden'
    const at = s.indexOf('@')
    if (at === -1) return s.slice(0, 3) + (s.length > 3 ? '***' : '')
    const user = s.slice(0, at)
    const domain = s.slice(at + 1)
    if (user.length <= 2) return `***@${domain}`
    return `***${user.slice(-2)}@${domain}`
}

function stripAnsi(s: string) {
    return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

function truncateVisible(s: string, max: number) {
    const visible = stripAnsi(s)
    return visible.length <= max ? visible : visible.slice(0, max - 1)
}

function pad(n: number) {
    return String(n).padStart(2, '0')
}

function formatElapsed(ms: number) {
    const s = Math.floor(ms / 1000)
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/* ===================== UI ===================== */

function formatMainScreen(): string {
    const rows = process.stdout.rows || 24
    const elapsed = formatElapsed(Date.now() - startTime)

    let statusLine: string
    if (activeAccounts.length === 0) {
        statusLine = '  No account selected'
    } else if (activeAccounts.length === 1) {
        statusLine = `  Farming points on account ${partialAccount(activeAccounts[0]!)}`
    } else {
        const list = activeAccounts.map(partialAccount).join(', ')
        statusLine = `  Farming points on accounts ${list}`
    }

    const banner = [
        '',
        '',
        '',
        ' d8888b  88bd88b d8888b d888b8b    88bd8b,d88b ',
        "d8P' `P  88P'  `d8b_,dPd8P' ?88    88P'`?8P'?8b",
        '88b     d88     88b    88b  ,88b  d88  d88  88P',
        "`?888P'd88'     `?888P'`?88P'`88bd88' d88'  88b",
        '',
        statusLine,
        '',
        `   Run time: [${elapsed}]`,
        `   Version: ${version}`,
        '',
        ''
    ]

    const cols = process.stdout.columns || 80
    const top = Math.max(0, Math.floor((rows - banner.length) / 2))
    const centered = [
        ...Array(top).fill(''),
        ...banner.map(l => {
            const vis = truncateVisible(l, cols)
            return ' '.repeat(Math.max(0, Math.floor((cols - vis.length) / 2))) + vis
        })
    ]

    return '\x1b[2J\x1b[H' + centered.map(l => PINK(l)).join('\n')
}

function formatLogsScreen(): string {
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    const avail = Math.max(3, rows - 4)
    const slice = logs.slice(-avail)

    return '\x1b[2J\x1b[H' + [
        PINK('-- LOGS --'),
        PINK('-'.repeat(Math.min(50, cols))),
        ...slice.map(l => truncateVisible(l, cols)),
        PINK('-'.repeat(Math.min(50, cols)))
    ].join('\n')
}

function draw() {
    if (!uiActive) return
    process.stdout.write(showingLogs ? formatLogsScreen() : formatMainScreen())
}

/* ===================== LOGS ===================== */

function onLog(e: LogEntry) {
    const line = `[${new Date(e.timestamp).toLocaleString()}] [${e.platform}] ${e.level.toUpperCase()} [${e.title}] ${e.message}`
    logs.push(line)
    if (logs.length > 500) logs.shift()

    if (e.level === 'error' && config) {
        void sendErrorReport(config, new Error(line), {
            title: e.title,
            platform: e.platform
        }).then(id => id && errorIDs.push(id)).catch(() => {})
    }
}

/* ===================== API ===================== */

export function startUI(opts: {
    versionStr?: string
    accounts?: string[]
    config?: any
} = {}) {
    if (uiActive) return

    uiActive = true
    startTime = Date.now()
    if (opts.versionStr) version = opts.versionStr
    if (opts.accounts) activeAccounts = opts.accounts
    if (opts.config) config = opts.config

    process.stdout.write('\x1B[?1049h\x1B[?25l')
    logEventEmitter.on('log', onLog)

    interval = setInterval(draw, 1000)
    draw()
}

export function stopUI() {
    if (!uiActive) return
    uiActive = false
    if (interval) clearInterval(interval)

    logEventEmitter.removeListener('log', onLog)
    process.stdout.write('\x1B[?25h\x1B[?1049l')
}

export default { startUI, stopUI }

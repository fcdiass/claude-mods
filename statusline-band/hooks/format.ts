// Port of ~/.claude/statusline.py, plus the mod-only figures: builds the two lines as colored segments.

// `press` makes the segment interactive: `model` opens the /model picker, `folder` shows and
// copies the path, `usage` and `context` swap to the cost and the token count on a click.
export type Press = 'model' | 'folder' | 'usage' | 'context'
export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean; underline?: boolean; press?: Press }

export const C = {
  CY: 'cyan',
  GR: 'green',
  YL: 'yellow',
  OR: '#d77800', // orange (warning)
  RD: 'red',
  BL: '#0891b2', // custom blue
  WH: 'white',
} as const

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

export type RateLimit = { percentUsed?: number; resetsAt?: string; etaMs?: number }

export type Running = { label: string; startedAt: number; count: number }

export type StatusInput = {
  model: string
  effort?: string | null
  cwd: string
  git: { repo: string; branch: string } | null
  contextPercent?: number
  costUsd?: number
  /** A subscription's account: the 5h/7d windows are what limits it, so they stand in for the cost. */
  hasWindows: boolean
  fiveHour?: RateLimit
  sevenDay?: RateLimit
  running?: Running
  nowMs: number
}

const SEP: Seg = { text: ' │ ', dim: true }

// A tool call shows on the band once it has run this long.
export const RUNNING_SHOWN_AFTER_MS = 2000

export function fmtDuration(ms: number): string {
  if (!ms) return '--'
  let s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  let m = Math.floor(s / 60)
  s %= 60
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  m %= 60
  return `${h}h${String(m).padStart(2, '0')}m`
}

// claude-opus-5-5 -> Opus 5.5, claude-haiku-4-5-20251001 -> Haiku 4.5, a [1m] suffix -> (1M); anything else as given.
export function modelName(id: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id)
  if (!m) return id
  const [, family = '', major, minor, isLong] = m
  const name = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()
  return `${name} ${major}${minor ? '.' + minor : ''}${isLong ? ' (1M)' : ''}`
}

// The band's one button: `Opus 5.5 · medium`, or the model alone before the effort is known.
export function modelEffortLabel(model: string, effort: string | null | undefined): string {
  const name = model ? modelName(model) : '--'
  return effort ? `${name} · ${effort}` : name
}

// Every bar on the band (context, 5h, 7d) has this many cells, so they line up alike.
export const BAR_WIDTH = 10

export function bar(pct: number, width = BAR_WIDTH): string {
  const filled = Math.max(0, Math.min(width, Math.floor((pct * width) / 100)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function fmtPct(val: number | undefined): string {
  return val === undefined ? '--' : `${val.toFixed(0)}%`
}

// Compact span: 1d02h, 1h30m, 12m.
export function fmtSpan(ms: number): string {
  let m = Math.floor(ms / 60_000)
  let h = Math.floor(m / 60)
  m %= 60
  const d = Math.floor(h / 24)
  h %= 24
  if (d) return `${d}d${String(h).padStart(2, '0')}h`
  if (h) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

export function fmtReset(resetsAtMs: number | undefined, nowMs: number): string {
  if (resetsAtMs === undefined) return ''
  const remaining = Math.floor(resetsAtMs / 1000) - Math.floor(nowMs / 1000)
  if (remaining <= 0) return '↺ now'
  return `↺ ${fmtSpan(remaining * 1000)}`
}

export function parseReset(resetsAt: string | undefined): number | undefined {
  const ms = resetsAt ? Date.parse(resetsAt) : NaN
  return Number.isNaN(ms) ? undefined : ms
}

export function windowFraction(resetsAtMs: number | undefined, windowMs: number, nowMs: number): number | undefined {
  if (resetsAtMs === undefined) return undefined
  const start = resetsAtMs - windowMs
  if (nowMs <= start) return 0
  if (nowMs >= resetsAtMs) return 1
  return (nowMs - start) / windowMs
}

// Blue: at or below the time-elapsed pace; orange: ahead of pace; red: >= 80% consumed.
export function rateLimitColor(usedPct: number | undefined, elapsed: number | undefined): string {
  if (usedPct === undefined) return C.BL
  if (usedPct >= 80) return C.RD
  if (elapsed !== undefined && usedPct > elapsed * 100) return C.OR
  return C.BL
}

// The projection warns only when 100% comes this soon, as a fraction of the time left to the reset.
export const PROJECTION_WARN_FRACTION = 0.6

/**
 * Time from now until the window reaches 100% at its average rate so far (a rule of three:
 * used% over the time elapsed since the window opened), or undefined when at that pace it
 * would not get there within PROJECTION_WARN_FRACTION of the time left to the reset, or
 * nothing is used yet.
 */
export function projectByPace(
  usedPct: number | undefined,
  resetsAtMs: number | undefined,
  windowMs: number,
  nowMs: number,
): number | undefined {
  if (usedPct === undefined || usedPct <= 0 || usedPct >= 100 || resetsAtMs === undefined) return undefined
  const elapsedMs = nowMs - (resetsAtMs - windowMs)
  if (elapsedMs <= 0 || nowMs >= resetsAtMs) return undefined
  const etaMs = (elapsedMs * (100 - usedPct)) / usedPct
  return etaMs < PROJECTION_WARN_FRACTION * (resetsAtMs - nowMs) ? etaMs : undefined
}

export function rateLimitBar(usedPct: number | undefined, elapsed: number | undefined, color: string, width = BAR_WIDTH): Seg[] {
  const used = usedPct === undefined ? 0 : Math.max(0, Math.min(100, Math.round(usedPct)))
  const filled = Math.max(0, Math.min(width, Math.floor((used * width) / 100)))
  const marker = elapsed === undefined ? undefined : Math.min(width - 1, Math.max(0, Math.floor(elapsed * width)))
  const segs: Seg[] = []
  for (let i = 0; i < width; i++) {
    if (i === marker) segs.push({ text: '│', color: C.WH })
    else if (i < filled) segs.push({ text: '█', color })
    else segs.push({ text: '░', dim: true })
  }
  return segs
}

// The window's color as statusline.py picks it, the reset-now case included.
export function windowColor(rl: RateLimit | undefined, windowMs: number, nowMs: number): string {
  const resetsAtMs = parseReset(rl?.resetsAt)
  const isResetNow = resetsAtMs !== undefined && resetsAtMs <= nowMs
  if (isResetNow) return rateLimitColor(undefined, undefined)
  return rateLimitColor(rl?.percentUsed, windowFraction(resetsAtMs, windowMs, nowMs))
}

function rateLimitSegs(label: string, rl: RateLimit | undefined, windowMs: number, nowMs: number): Seg[] {
  const used = rl?.percentUsed
  const resetsAtMs = parseReset(rl?.resetsAt)
  // When the window has fully elapsed, zero out both fill and marker.
  const isResetNow = resetsAtMs !== undefined && resetsAtMs <= nowMs
  const elapsed = windowFraction(resetsAtMs, windowMs, nowMs)
  const color = windowColor(rl, windowMs, nowMs)
  const reset = fmtReset(resetsAtMs, nowMs)
  const eta = isResetNow ? undefined : rl?.etaMs
  return [
    { text: `${label} ` },
    ...rateLimitBar(isResetNow ? 0 : used, isResetNow ? undefined : elapsed, color),
    { text: ' ' },
    { text: fmtPct(used), color },
    ...(reset ? [{ text: ` ${reset}`, dim: true }] : []),
    ...(eta !== undefined ? [{ text: ` ⚠ 100% in ${fmtSpan(eta)}`, color: C.RD, bold: true }] : []),
  ]
}

// What the session has cost: what an API account pays.
export function costSegs(costUsd: number | undefined): Seg[] {
  return [{ text: 'cost ' }, { text: `$${(costUsd ?? 0).toFixed(2)}`, color: C.YL }]
}

// On a subscription, a click on the windows swaps them for what the session would cost on the API.
function contextColor(pct: number): string {
  return pct >= 85 ? C.RD : pct >= 70 ? C.YL : C.GR
}

// 950 -> 950, 358700 -> 358.7k, 200000 -> 200k, 1000000 -> 1M.
export function fmtTokens(n: number): string {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, '')
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}k`
  return String(Math.round(n))
}

// A click on the context bar swaps it for the tokens in use out of the window: ctx 358.7k / 1M.
export function contextAltSegs(percent: number | undefined, tokens: number | undefined, window: number): Seg[] {
  const color = contextColor(Math.trunc(percent ?? 0))
  return [{ text: 'ctx ' }, { text: `${fmtTokens(tokens ?? 0)} / ${fmtTokens(window)}`, color }]
}

export function costAltSegs(costUsd: number | undefined): Seg[] {
  return [{ text: 'cost ≈ ' }, { text: `$${(costUsd ?? 0).toFixed(2)}`, color: C.YL }, { text: ' API-equivalent', dim: true }]
}

export function buildLines(s: StatusInput): [Seg[], Seg[]] {
  const cwdN = s.cwd.replace(/\\/g, '/')
  const folder = cwdN.replace(/\/+$/, '').split('/').pop() || cwdN

  const gitSegs: Seg[] = s.git
    ? [
        { text: '⎇  ', color: C.GR, press: 'folder' },
        { text: s.git.repo, color: C.GR, bold: true, press: 'folder' },
        { text: ':', dim: true, press: 'folder' },
        { text: s.git.branch, color: C.YL, press: 'folder' },
      ]
    : [{ text: `📁 ${folder}`, dim: true, press: 'folder' }]

  const runningMs = s.running ? s.nowMs - s.running.startedAt : 0
  const runningSegs: Seg[] =
    s.running && runningMs >= RUNNING_SHOWN_AFTER_MS
      ? [
          SEP,
          { text: `▶ ${s.running.label} `, color: C.BL, bold: true },
          { text: fmtDuration(runningMs), color: C.BL },
          ...(s.running.count > 1 ? [{ text: ` +${s.running.count - 1}`, dim: true }] : []),
        ]
      : []

  const line1: Seg[] = [
    { text: '◆ ', color: C.CY, bold: true },
    { text: modelEffortLabel(s.model, s.effort), color: C.CY, bold: true, press: 'model' },
    SEP,
    ...gitSegs,
    ...runningSegs,
  ]

  const pct = Math.trunc(s.contextPercent ?? 0)
  const ctxColor = contextColor(pct)

  const line2: Seg[] = [
    { text: 'ctx ', press: 'context' },
    { text: bar(pct), color: ctxColor, press: 'context' },
    { text: ' ', press: 'context' },
    { text: `${pct}%`, color: ctxColor, press: 'context' },
    SEP,
    ...(s.hasWindows
      ? [
          ...rateLimitSegs('5h', s.fiveHour, FIVE_HOUR_MS, s.nowMs),
          SEP,
          ...rateLimitSegs('7d', s.sevenDay, SEVEN_DAY_MS, s.nowMs),
        ].map(seg => ({ ...seg, press: 'usage' as const }))
      : costSegs(s.costUsd)),
  ]

  return [line1, line2]
}

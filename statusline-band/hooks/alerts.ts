// Which gauges are past a threshold, and the toast each raises when it climbs to that level.

import { C, FIVE_HOUR_MS, SEVEN_DAY_MS, fmtSpan, fmtTokens, parseReset, windowColor } from './format'
import type { RateLimit } from './format'
import type { CacheStatus } from './cache'

export type Gauge = { level: number; message: string }

export type AlertInput = {
  contextPercent?: number
  compactAtPercent?: number
  fiveHour?: RateLimit
  sevenDay?: RateLimit
  nowMs: number
}

// A command that runs at least this long toasts when it ends.
export const LONG_TOOL_MS = 60_000

function windowGauges(key: string, label: string, rl: RateLimit | undefined, windowMs: number, nowMs: number): Record<string, Gauge> {
  if (rl?.percentUsed === undefined) return {}
  const pct = rl.percentUsed.toFixed(0)
  const resetsAtMs = parseReset(rl.resetsAt)
  const reset = resetsAtMs !== undefined && resetsAtMs > nowMs ? `, resets in ${fmtSpan(resetsAtMs - nowMs)}` : ''
  const color = windowColor(rl, windowMs, nowMs)
  const level = color === C.RD ? 2 : color === C.OR ? 1 : 0
  const gauges: Record<string, Gauge> = {
    [key]: {
      level,
      message: level === 2 ? `${label} window at ${pct}%${reset}` : `${label} window ahead of pace: ${pct}% used${reset}`,
    },
  }
  if (rl.etaMs !== undefined) {
    gauges[`${key}.eta`] = { level: 1, message: `${label} window: at this pace it hits 100% in ${fmtSpan(rl.etaMs)}${reset}` }
  }
  return gauges
}

export function gauges(s: AlertInput): Record<string, Gauge> {
  const ctx = Math.round(s.contextPercent ?? 0)
  const compactAt = s.compactAtPercent === undefined ? '' : ` (auto-compacts at ${Math.round(s.compactAtPercent)}%)`
  return {
    context: {
      level: ctx >= 85 ? 2 : ctx >= 70 ? 1 : 0,
      message: `Context at ${ctx}%${compactAt}`,
    },
    ...windowGauges('five_hour', '5h', s.fiveHour, FIVE_HOUR_MS, s.nowMs),
    ...windowGauges('seven_day', '7d', s.sevenDay, SEVEN_DAY_MS, s.nowMs),
  }
}

// The skill ai-memory installs; with it, a session can wrap up into a handoff and /clear.
export const HANDOFF_SKILL = 'ai-memory-handoff'

// Before the cache lapses: wrapping up now costs a turn over a warm cache, later a rebuild.
export function cacheExpiryMessage(remainingMs: number, tokens: number, hasHandoff: boolean): string {
  const wrapUp = hasHandoff
    ? `Done for now? /${HANDOFF_SKILL} while it is warm, then /clear`
    : 'Done for now? /compact while it is warm, or /clear for a new task'
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  return `Prompt cache lapses in ${minutes}m: the next prompt after that re-caches ${fmtTokens(tokens)} tokens. ${wrapUp}`
}

// A prompt that went out over a cold cache: what it cost, and how to spare the next one.
export function coldPromptMessage(tokens: number, hasHandoff: boolean): string {
  const next = hasHandoff
    ? `Next time, /${HANDOFF_SKILL} before it lapses lets you /clear and resume`
    : 'Next time, /compact before it lapses, or /clear for a new task'
  return `Prompt cache was cold: this prompt re-caches ${fmtTokens(tokens)} tokens. ${next}`
}

// A prompt typed over a cold cache is held and this asked: send it, or shrink or leave the
// conversation first. The choices are the dialog's labels; Esc or a typed answer sends nothing.
export const COLD_SEND = 'Send anyway'
export const COLD_COMPACT = 'Compact first'
export const COLD_HANDOFF = 'Handoff, then new'
export const COLD_NEW = 'New conversation'

export function coldQuestion(tokens: number): string {
  return `Prompt cache is cold: sending this prompt re-caches ${fmtTokens(tokens)} tokens. What now?`
}

export function coldChoices(hasHandoff: boolean): string[] {
  return hasHandoff ? [COLD_SEND, COLD_COMPACT, COLD_HANDOFF, COLD_NEW] : [COLD_SEND, COLD_COMPACT, COLD_NEW]
}

// The commands a choice runs before the prompt goes back to the box; undefined for an answer
// that runs none (Esc, a typed answer).
export function coldCommands(choice: string): string[] | undefined {
  if (choice === COLD_COMPACT) return ['compact']
  if (choice === COLD_HANDOFF) return [HANDOFF_SKILL, 'clear']
  if (choice === COLD_NEW) return ['clear']
  return undefined
}

// The line the held prompt leaves in place of the turn.
export function heldMessage(choice: string | undefined): string {
  if (choice === COLD_COMPACT) return 'Prompt held while the conversation compacts; it goes back to the prompt box'
  if (choice === COLD_HANDOFF) return 'Prompt held for a handoff and a new conversation; it goes back to the prompt box'
  if (choice === COLD_NEW) return 'Prompt held for a new conversation; it goes back to the prompt box'
  return 'Prompt held over a cold cache and put back in the prompt box; Enter sends it as is'
}

// A click on the cache's countdown: its state, when it lapses, its size and how well it served.
export function cacheDetailsMessage(c: CacheStatus, nowMs: number): string {
  const at = new Date(nowMs + c.remainingMs)
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const state =
    c.remainingMs > 0
      ? `warm, lapses in ${fmtSpan(c.remainingMs)} (${clock}); ${fmtTokens(c.tokens)} tokens cached`
      : `cold; the next prompt re-caches ${fmtTokens(c.tokens)} tokens`
  const rebuilds = `${c.rebuilds} rebuild${c.rebuilds === 1 ? '' : 's'}`
  return `Prompt cache ${state} · TTL ${c.ttlMs >= 3_600_000 ? '1h' : '5m'} · ${Math.round(c.hitPercent)}% hit · ${rebuilds}`
}

/**
 * The toasts owed now and the levels to remember: a gauge toasts when it climbs
 * above the level last remembered; a drop is remembered silently, re-arming it.
 */
export function climb(
  previous: Readonly<Record<string, number>>,
  current: Readonly<Record<string, Gauge>>,
  minLevel = 1,
): { toasts: string[]; levels: Record<string, number> } {
  const toasts: string[] = []
  const levels: Record<string, number> = {}
  for (const [key, gauge] of Object.entries(current)) {
    // Below `minLevel` a climb is remembered without a toast.
    if (gauge.level > (previous[key] ?? 0) && gauge.level >= minLevel) toasts.push(gauge.message)
    levels[key] = gauge.level
  }
  return { toasts, levels }
}

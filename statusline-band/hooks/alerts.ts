// Which gauges are past a threshold, and the toast each raises when it climbs to that level.

import { C, FIVE_HOUR_MS, SEVEN_DAY_MS, fmtSpan, parseReset, windowColor } from './format'
import type { RateLimit } from './format'

export type Gauge = { level: number; message: string }

export type AlertInput = {
  contextPercent?: number
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
  const ctx = Math.trunc(s.contextPercent ?? 0)
  return {
    context: {
      level: ctx >= 85 ? 2 : ctx >= 70 ? 1 : 0,
      message: `Context at ${ctx}%`,
    },
    ...windowGauges('five_hour', '5h', s.fiveHour, FIVE_HOUR_MS, s.nowMs),
    ...windowGauges('seven_day', '7d', s.sevenDay, SEVEN_DAY_MS, s.nowMs),
  }
}

/**
 * The toasts owed now and the levels to remember: a gauge toasts when it climbs
 * above the level last remembered; a drop is remembered silently, re-arming it.
 */
export function climb(
  previous: Readonly<Record<string, number>>,
  current: Readonly<Record<string, Gauge>>,
): { toasts: string[]; levels: Record<string, number> } {
  const toasts: string[] = []
  const levels: Record<string, number> = {}
  for (const [key, gauge] of Object.entries(current)) {
    if (gauge.level > (previous[key] ?? 0)) toasts.push(gauge.message)
    levels[key] = gauge.level
  }
  return { toasts, levels }
}

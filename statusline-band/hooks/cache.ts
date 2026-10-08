// The main conversation's prompt cache, as the mod reckons it from the usage of each model request:
// when the last one was, how big the cached prefix is, and when the entry lapses.

import type { CacheMark, CacheTtl } from '../types'

export type { CacheMark, CacheTtl }

export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

// A prefix this big toasts before it lapses and when a prompt goes out over it cold.
export const CACHE_ALERT_TOKENS = 100_000

// A request that wrote at least this share of a prefix this big rebuilt the cache.
const REBUILD_SHARE = 0.5
const REBUILD_MIN_TOKENS = 50_000

export type StepUsage = {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

export function recordStep(previous: CacheMark | null, usage: StepUsage, nowMs: number): CacheMark {
  const read = usage.cache_read_input_tokens
  const written = usage.cache_creation_input_tokens
  const tokens = read + written + usage.input_tokens
  const isRebuild = tokens >= REBUILD_MIN_TOKENS && written >= REBUILD_SHARE * tokens
  return {
    at: nowMs,
    tokens,
    model: usage.model,
    readTokens: (previous?.readTokens ?? 0) + read,
    inputTokens: (previous?.inputTokens ?? 0) + tokens,
    rebuilds: (previous?.rebuilds ?? 0) + (isRebuild ? 1 : 0),
    isExpiryWarned: false,
  }
}

function isOn(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

function asTtl(value: unknown): CacheTtl | undefined {
  return value === '5m' || value === '1h' ? value : undefined
}

/**
 * The TTL the settings force on the main conversation, by Claude Code's precedence:
 * FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, the promptCacheTtl setting,
 * ENABLE_PROMPT_CACHING_1H; null when none does.
 */
export function ttlOverride(s: { force5m?: string; envTtl?: string; settingTtl?: unknown; enable1h?: string }): CacheTtl | null {
  if (isOn(s.force5m)) return '5m'
  const chosen = asTtl(s.envTtl?.trim()) ?? asTtl(s.settingTtl)
  if (chosen) return chosen
  return isOn(s.enable1h) ? '1h' : null
}

// Unforced: 1h on a subscription within its plan, 5m otherwise (an API key, or a subscription
// past a window, now on usage credits).
export function cacheTtl(override: CacheTtl | null, hasWindows: boolean, isPastWindow: boolean): CacheTtl {
  return override ?? (hasWindows && !isPastWindow ? '1h' : '5m')
}

// claude-opus-5-5[1m] and claude-opus-5-5-20260101 name the same model as claude-opus-5-5.
function sameModel(a: string, b: string): boolean {
  const norm = (id: string) => id.toLowerCase().replace(/\[[^\]]*\]$/, '')
  const [x, y] = [norm(a), norm(b)]
  return x === y || x.startsWith(y + '-') || y.startsWith(x + '-')
}

export type CacheStatus = {
  /** Time left before the entry lapses; zero or less when it is cold. */
  remainingMs: number
  ttlMs: number
  /** The prefix the next request reads, or writes again when cold. */
  tokens: number
  /** Share of all input tokens the cache served, 0-100. */
  hitPercent: number
  rebuilds: number
}

// A model other than the one the cache was made for starts cold.
export function cacheStatus(mark: CacheMark | null, ttl: CacheTtl, model: string, nowMs: number): CacheStatus | undefined {
  if (!mark) return undefined
  const ttlMs = TTL_MS[ttl]
  const remainingMs = model && !sameModel(model, mark.model) ? 0 : mark.at + ttlMs - nowMs
  return {
    remainingMs,
    ttlMs,
    tokens: mark.tokens,
    hitPercent: mark.inputTokens > 0 ? (mark.readTokens / mark.inputTokens) * 100 : 0,
    rebuilds: mark.rebuilds,
  }
}

// How long before the entry lapses the band turns yellow and red, and the toast shows.
export function warnLeadMs(ttlMs: number): number {
  return Math.min(10 * 60_000, ttlMs * 0.4)
}
export function urgentLeadMs(ttlMs: number): number {
  return Math.min(5 * 60_000, ttlMs * 0.2)
}

export function isExpiryDue(status: CacheStatus | undefined): boolean {
  return (
    status !== undefined &&
    status.remainingMs > 0 &&
    status.remainingMs <= urgentLeadMs(status.ttlMs) &&
    status.tokens >= CACHE_ALERT_TOKENS
  )
}

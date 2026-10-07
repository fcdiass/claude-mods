import { expect, test } from 'claude-code/testing'

import { C, bar, buildLines, costAltSegs, fmtDuration, fmtReset, FIVE_HOUR_MS, SEVEN_DAY_MS, modelName, projectByPace, rateLimitColor } from './format'

const text = (segs: { text: string }[]) => segs.map(s => s.text).join('')

test('durations match statusline.py', async () => {
  expect(fmtDuration(0)).toBe('--')
  expect(fmtDuration(42_000)).toBe('42s')
  expect(fmtDuration(125_000)).toBe('2m05s')
  expect(fmtDuration(3_720_000)).toBe('1h02m')
})

test('context bar fills by tenths', async () => {
  expect(bar(21)).toBe('██░░░░░░░░')
  expect(bar(100)).toBe('██████████')
})

test('reset countdown', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  expect(fmtReset(now + 90 * 60_000, now)).toBe('↺ 1h30m')
  expect(fmtReset(now + 26 * 3600_000, now)).toBe('↺ 1d02h')
  expect(fmtReset(now - 1000, now)).toBe('↺ now')
})

test('rate-limit color follows pace', async () => {
  expect(rateLimitColor(30, 0.5)).toBe(C.BL)
  expect(rateLimitColor(60, 0.5)).toBe(C.OR)
  expect(rateLimitColor(85, 0.9)).toBe(C.RD)
})

test('builds both lines', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const [l1, l2] = buildLines({
    model: 'Opus 5.5',
    cwd: 'C:\\Users\\me\\repo',
    git: { repo: 'repo', branch: 'develop' },
    contextPercent: 72.4,
    costUsd: 1.4,
    hasWindows: true,
    fiveHour: { percentUsed: 34, resetsAt: new Date(now + 2 * 3600_000).toISOString() },
    sevenDay: undefined,
    nowMs: now,
  })
  expect(text(l1)).toBe('◆ Opus 5.5 │ ⎇  repo:develop')
  expect(text(l2)).toContain('ctx ███████░░░ 72%')
  expect(text(l2)).not.toContain('dur')
  expect(text(l2)).toContain('34% ↺ 2h00m')
  expect(text(l2)).toContain('7d ░░░░░░░░░░░░░░ --')
})

test('a subscription shows the windows, not the cost; an API account the cost, not the windows', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const base = { model: 'm', cwd: '/x', git: null, costUsd: 22.06, nowMs: now }
  const [, subscription] = buildLines({ ...base, hasWindows: true })
  expect(text(subscription)).toContain('5h ')
  expect(text(subscription)).not.toContain('cost')
  expect(subscription.filter(seg => seg.text.includes('5h') || seg.text.includes('7d')).every(seg => seg.press === 'usage')).toBe(true)

  const [, api] = buildLines({ ...base, hasWindows: false })
  expect(text(api)).toContain('cost $22.06')
  expect(text(api)).not.toContain('5h')
})

test('the cost a click shows reads as an API estimate', async () => {
  expect(text(costAltSegs(22.06))).toBe('cost ≈ $22.06 API-equivalent')
})

test('projection by pace: ahead of the time elapsed reaches 100% before the reset', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  // 1h into the 5h window (20% of it) with 40% used: 2.5h to 100%, so 1h30m from now, before the reset.
  expect(projectByPace(40, now + 4 * 3600_000, FIVE_HOUR_MS, now)).toBe(90 * 60_000)
})

test('projection by pace: none at or behind the time elapsed, or with nothing used', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  // The screenshot: 5h at 17% with 4h05m left (55 min in, 18%); 7d at 22% with 4d10h left (37% in).
  expect(projectByPace(17, now + (4 * 60 + 5) * 60_000, FIVE_HOUR_MS, now)).toBeUndefined()
  expect(projectByPace(22, now + (4 * 24 + 10) * 3600_000, SEVEN_DAY_MS, now)).toBeUndefined()
  // Exactly on pace reaches 100% at the reset itself: no warning.
  expect(projectByPace(20, now + 4 * 3600_000, FIVE_HOUR_MS, now)).toBeUndefined()
  expect(projectByPace(0, now + 4 * 3600_000, FIVE_HOUR_MS, now)).toBeUndefined()
  expect(projectByPace(undefined, now + 4 * 3600_000, FIVE_HOUR_MS, now)).toBeUndefined()
})

test('the band shows the projection and the running tool', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const [l1, l2] = buildLines({
    model: 'm',
    hasWindows: true,
    cwd: '/x',
    git: null,
    fiveHour: { percentUsed: 60, resetsAt: new Date(now + 2 * 3600_000).toISOString(), etaMs: 40 * 60_000 },
    running: { label: 'PowerShell: Run calibration', startedAt: now - 134_000, count: 2 },
    nowMs: now,
  })
  expect(text(l1)).toContain('▶ PowerShell: Run calibration 2m14s +1')
  expect(text(l2)).toContain('↺ 2h00m ⚠ 100% in 40m')
})

test('a tool call under two seconds stays off the band', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const [l1] = buildLines({
    model: 'm', cwd: '/x', git: null, hasWindows: false, nowMs: now,
    running: { label: 'Read', startedAt: now - 500, count: 1 },
  })
  expect(text(l1)).not.toContain('▶')
})

test('model ids read as their names', async () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M)')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelName('some-gateway-model')).toBe('some-gateway-model')
})

test('effort follows the model on the first line', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const base = { cwd: '/x', git: null, hasWindows: false, nowMs: now }
  const [withEffort] = buildLines({ ...base, model: 'claude-opus-5-5', effort: 'high' })
  expect(text(withEffort).startsWith('◆ Opus 5.5 · high │')).toBe(true)
  const [without] = buildLines({ ...base, model: 'claude-opus-5-5', effort: null })
  expect(text(without).startsWith('◆ Opus 5.5 │')).toBe(true)
})

test('outside a repository the folder name stands alone, with no full path', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const [l1] = buildLines({ model: 'claude-opus-5-5', effort: 'medium', cwd: 'D:/repos/TEST/claude-mods', git: null, hasWindows: false, nowMs: now })
  expect(text(l1)).toBe('◆ Opus 5.5 · medium │ 📁 claude-mods')
})

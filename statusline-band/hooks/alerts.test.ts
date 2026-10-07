import { expect, test } from 'claude-code/testing'

import { climb, gauges } from './alerts'

const NOW = Date.parse('2026-10-07T12:00:00Z')

test('each climb toasts once; a drop re-arms', async () => {
  const at = (contextPercent: number) => gauges({ contextPercent, nowMs: NOW })

  const first = climb({}, at(72))
  expect(first.toasts).toEqual(['Context at 72%'])

  const same = climb(first.levels, at(75))
  expect(same.toasts).toEqual([])

  const higher = climb(same.levels, at(86))
  expect(higher.toasts).toEqual(['Context at 86%'])

  const dropped = climb(higher.levels, at(20))
  expect(dropped.toasts).toEqual([])
  expect(climb(dropped.levels, at(71)).toasts).toEqual(['Context at 71%'])
})

test('5h window ahead of pace, critical and projected', async () => {
  // Half an hour into the window (10% of the time) with 30% used: ahead of pace.
  const resetsAt = new Date(NOW + 4.5 * 3600_000).toISOString()
  const ahead = gauges({ fiveHour: { percentUsed: 30, resetsAt }, nowMs: NOW })
  expect(ahead.five_hour?.level).toBe(1)
  expect(ahead.five_hour?.message).toBe('5h window ahead of pace: 30% used, resets in 4h30m')

  const critical = gauges({ fiveHour: { percentUsed: 82, resetsAt, etaMs: 20 * 60_000 }, nowMs: NOW })
  expect(critical.five_hour?.level).toBe(2)
  expect(critical['five_hour.eta']?.message).toBe('5h window: at this pace it hits 100% in 20m, resets in 4h30m')
})

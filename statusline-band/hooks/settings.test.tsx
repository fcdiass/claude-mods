import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { climb } from './alerts'
import { buildLines } from './format'
import type { StatusInput } from './format'
import { DEFAULT_SETTINGS, readSettings, toastLevel } from './settings'
import type { Settings } from './settings'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const MIN = 60_000

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const INPUT: StatusInput = {
  model: 'claude-opus-5-5',
  cwd: 'D:/repos/claude-mods',
  git: { repo: 'claude-mods', branch: 'feature', changes: 2, ahead: 1, behind: 3, conflicts: 1, operation: 'REBASING 2/5' },
  contextPercent: 45,
  costUsd: 1.5,
  hasWindows: true,
  fiveHour: { percentUsed: 34, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() },
  running: { label: 'Bash: npm test', startedAt: NOW - 5000, count: 1 },
  cache: { remainingMs: 42 * MIN, ttlMs: 60 * MIN, tokens: 700_000, hitPercent: 90, rebuilds: 0 },
  nowMs: NOW,
}

const band = (settings: Partial<Settings>, input: Partial<StatusInput> = {}) =>
  buildLines({ ...INPUT, ...input, settings: { ...DEFAULT_SETTINGS, ...settings } }).map(line => line.map(seg => seg.text).join(''))

test('a value /config does not offer stands as its default', async () => {
  expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  expect(readSettings({ git: 'branch', usage: 'windows', cache: 'warn', toasts: 7, runningTool: false })).toEqual({
    git: 'branch',
    usage: 'auto',
    cache: 'warn',
    toasts: 'all',
    runningTool: false,
  })
})

test('the defaults draw the band as it always was', async () => {
  const [line1, line2] = band({})
  expect(line1).toBe('◆ Opus 5.5 │ ⎇  claude-mods:feature REBASING 2/5 ✖1 ●2 ↑1 ↓3 │ ▶ Bash: npm test 5s')
  expect(line2).toMatch(/^ctx \S+ 45% ● 42m │ 5h .* 34%/)
  expect(JSON.stringify(buildLines(INPUT))).toBe(JSON.stringify(buildLines({ ...INPUT, settings: DEFAULT_SETTINGS })))
})

test('git: branch keeps the branch and what is under way; off leaves the folder', async () => {
  expect(band({ git: 'branch' })[0]).toBe('◆ Opus 5.5 │ ⎇  claude-mods:feature REBASING 2/5 ✖1 │ ▶ Bash: npm test 5s')
  expect(band({ git: 'off' })[0]).toBe('◆ Opus 5.5 │ 📁 claude-mods │ ▶ Bash: npm test 5s')
})

test('usage: rate limits or cost whatever the account, or nothing', async () => {
  expect(band({ usage: 'rate-limits' }, { hasWindows: false })[1]).toMatch(/│ 5h .* 34%/)
  expect(band({ usage: 'cost' })[1]).toMatch(/│ cost \$1\.50$/)
  expect(band({ usage: 'auto' }, { hasWindows: false })[1]).toMatch(/│ cost \$1\.50$/)
  expect(band({ usage: 'off' })[1]).toMatch(/^ctx \S+ 45% ● 42m$/)
})

test('cache off hides the countdown, warn keeps it; running tool off hides the tool', async () => {
  expect(band({ cache: 'off' })[1]).not.toContain('42m')
  expect(band({ cache: 'warn' })[1]).toContain('● 42m')
  expect(band({ runningTool: false })[0]).toBe('◆ Opus 5.5 │ ⎇  claude-mods:feature REBASING 2/5 ✖1 ●2 ↑1 ↓3')
})

test('toasts: critical lets only the red thresholds speak, off none; the levels are kept all the same', async () => {
  const gauges = { context: { level: 2, message: 'Context at 86%' }, five_hour: { level: 1, message: '5h ahead of pace' } }
  expect(climb({}, gauges, toastLevel('all')).toasts).toEqual(['Context at 86%', '5h ahead of pace'])
  expect(climb({}, gauges, toastLevel('critical')).toasts).toEqual(['Context at 86%'])
  const silent = climb({}, gauges, toastLevel('off'))
  expect(silent.toasts).toEqual([])
  expect(silent.levels).toEqual({ context: 2, five_hour: 1 })
})

const usage = (read: number, written: number) => ({
  input_tokens: 10,
  output_tokens: 500,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
  model: 'claude-opus-5-5',
})

// A large prefix cached, then left to lapse: the next prompt is typed over a cold cache.
function coldEngine(on: On) {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const asked: string[] = []
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: 'D:\\repo' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 705_010, window: 1_000_000, percent: 70.5 }, rateLimits: [], cost: { usd: 1 } },
  }))
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usage(700_000, 5_000) } as never
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked.push('asked')
    return { deny: 'dismissed' }
  })
  return { clock, toasts, asked }
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('cache: warn sends the prompt over a cold cache with a toast', { options: { cache: 'warn' } }, async ($, on) => {
  const { clock, toasts, asked } = coldEngine(on)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream);
  await stream.result
  await clock.advance(61 * MIN)

  expect(await $.prompt.submit(typed('go'))).toEqual({ text: 'go' })
  expect(asked).toEqual([])
  expect(toasts).toEqual([expect.stringMatching(/^Prompt cache was cold: this prompt re-caches 705k tokens/)])
})

test('cache: off sends it in silence, and the band has no countdown', { options: { cache: 'off' } }, async ($, on) => {
  const { clock, toasts, asked } = coldEngine(on)
  const view = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream);
  await stream.result
  await view.redraw()
  expect(await view.find({ key: 'cache-button' })).toBeUndefined()
  await clock.advance(61 * MIN)

  expect(await $.prompt.submit(typed('go'))).toEqual({ text: 'go' })
  expect(asked).toEqual([])
  expect(toasts).toEqual([])
  await view.unmount()
})

test('git: off never runs git', { options: { git: 'off' } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const ran: string[][] = []
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: 'D:\\repos\\claude-mods' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 10_000, window: 1_000_000, percent: 1 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: 'D:\\repos\\claude-mods', surface: 'terminal', isInteractive: true })
  const view = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  expect(JSON.stringify(await view.drawn())).toContain('claude-mods')
  expect(ran.filter(argv => argv[0] === 'git')).toEqual([])
  await view.unmount()
})

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  COLD_COMPACT,
  COLD_HANDOFF,
  COLD_NEW,
  COLD_SEND,
  cacheDetailsMessage,
  cacheExpiryMessage,
  coldChoices,
  coldCommands,
  coldPromptMessage,
} from './alerts'
import { cacheStatus, cacheTtl, isExpiryDue, recordStep, ttlOverride } from './cache'
import type { CacheStatus } from './cache'
import { C, buildLines, cacheSegs } from './format'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const MIN = 60_000

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const usage = (read: number, written: number, model = 'claude-opus-5-5') => ({
  input_tokens: 10,
  output_tokens: 500,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
  model,
})

test('the TTL follows Claude Code precedence, else the account', async () => {
  expect(ttlOverride({})).toBeNull()
  expect(ttlOverride({ force5m: '1', envTtl: '1h', settingTtl: '1h' })).toBe('5m')
  expect(ttlOverride({ envTtl: '5m', settingTtl: '1h', enable1h: '1' })).toBe('5m')
  expect(ttlOverride({ settingTtl: '1h' })).toBe('1h')
  expect(ttlOverride({ enable1h: 'true' })).toBe('1h')
  expect(ttlOverride({ envTtl: 'bogus', force5m: '0' })).toBeNull()
  expect(cacheTtl(null, true, false)).toBe('1h')
  expect(cacheTtl(null, true, true)).toBe('5m')
  expect(cacheTtl(null, false, false)).toBe('5m')
  expect(cacheTtl('1h', false, false)).toBe('1h')
})

test('each response marks the prefix, and one that writes most of a large prefix counts as a rebuild', async () => {
  const first = recordStep(null, usage(0, 20_000), NOW)
  expect(first).toMatchObject({ at: NOW, tokens: 20_010, rebuilds: 0, isExpiryWarned: false })
  const warm = recordStep(first, usage(700_000, 5_000), NOW + MIN)
  expect(warm).toMatchObject({ tokens: 705_010, rebuilds: 0 })
  const cold = recordStep({ ...warm, isExpiryWarned: true }, usage(20_000, 690_000), NOW + 90 * MIN)
  expect(cold).toMatchObject({ rebuilds: 1, isExpiryWarned: false })
  // 720k read of 1.435M sent.
  expect(Math.round(cacheStatus(cold, '1h', 'claude-opus-5-5', NOW + 90 * MIN)?.hitPercent ?? 0)).toBe(50)
})

test('the cache lapses with its TTL, and at once for another model', async () => {
  const mark = recordStep(null, usage(700_000, 5_000), NOW)
  expect(cacheStatus(null, '1h', 'claude-opus-5-5', NOW)).toBeUndefined()
  expect(cacheStatus(mark, '1h', 'claude-opus-5-5[1m]', NOW + 20 * MIN)?.remainingMs).toBe(40 * MIN)
  expect(cacheStatus(mark, '5m', 'claude-opus-5-5', NOW + 6 * MIN)?.remainingMs).toBeLessThan(0)
  expect(cacheStatus(mark, '1h', 'claude-sonnet-5-5', NOW + MIN)?.remainingMs).toBe(0)
})

test('the expiry toast is due in the last minutes of a large prefix', async () => {
  const status = (remainingMs: number, ttlMs = 60 * MIN, tokens = 700_000): CacheStatus => ({
    remainingMs,
    ttlMs,
    tokens,
    hitPercent: 90,
    rebuilds: 0,
  })
  expect(isExpiryDue(status(6 * MIN))).toBe(false)
  expect(isExpiryDue(status(5 * MIN))).toBe(true)
  expect(isExpiryDue(status(0))).toBe(false)
  expect(isExpiryDue(status(5 * MIN, 60 * MIN, 50_000))).toBe(false)
  // A 5m TTL warns its last minute.
  expect(isExpiryDue(status(2 * MIN, 5 * MIN))).toBe(false)
  expect(isExpiryDue(status(MIN, 5 * MIN))).toBe(true)
})

test('the band counts the cache down in green, yellow and red, then shows it cold', async () => {
  const at = (remainingMs: number, tokens = 700_000): CacheStatus => ({ remainingMs, ttlMs: 60 * MIN, tokens, hitPercent: 93.6, rebuilds: 2 })
  expect(cacheSegs(at(42 * MIN))).toEqual({ text: '● 42m', color: C.GR })
  expect(cacheSegs(at(9 * MIN + 30_000))).toEqual({ text: '● 9m30s', color: C.YL })
  expect(cacheSegs(at(45_000))).toEqual({ text: '● 45s', color: C.RD })
  expect(cacheSegs(at(-MIN))).toEqual({ text: '○ cold', color: C.OR })
  expect(cacheSegs(at(0, 30_000))).toEqual({ text: '○ cold', dim: true })
})

test('the countdown sits right after the context percentage, with no label', async () => {
  const [, line2] = buildLines({
    model: 'claude-opus-5-5',
    cwd: 'D:/repo',
    git: null,
    contextPercent: 45,
    hasWindows: false,
    costUsd: 1,
    cache: { remainingMs: 42 * MIN, ttlMs: 60 * MIN, tokens: 700_000, hitPercent: 90, rebuilds: 0 },
    nowMs: NOW,
  })
  expect(line2.map(seg => seg.text).join('')).toMatch(/^ctx \S+ 45% ● 42m │ cost/)
  expect(line2.find(seg => seg.text === '● 42m')?.press).toBe('cache')
})

test('the details a click shows', async () => {
  const at = (remainingMs: number): CacheStatus => ({ remainingMs, ttlMs: 60 * MIN, tokens: 746_000, hitPercent: 93.6, rebuilds: 1 })
  expect(cacheDetailsMessage(at(42 * MIN), NOW)).toMatch(
    /^Prompt cache warm, lapses in 42m \(\d\d:\d\d\); 746k tokens cached · TTL 1h · 94% hit · 1 rebuild$/,
  )
  expect(cacheDetailsMessage(at(-MIN), NOW)).toBe('Prompt cache cold; the next prompt re-caches 746k tokens · TTL 1h · 94% hit · 1 rebuild')
})

test('the advice names ai-memory handoff only when it is installed', async () => {
  expect(cacheExpiryMessage(5 * MIN, 746_000, false)).toBe(
    'Prompt cache lapses in 5m: the next prompt after that re-caches 746k tokens. Done for now? /compact while it is warm, or /clear for a new task',
  )
  expect(cacheExpiryMessage(4 * MIN + 10_000, 746_000, true)).toBe(
    'Prompt cache lapses in 5m: the next prompt after that re-caches 746k tokens. Done for now? /ai-memory-handoff while it is warm, then /clear',
  )
  expect(coldPromptMessage(746_000, false)).toBe(
    'Prompt cache was cold: this prompt re-caches 746k tokens. Next time, /compact before it lapses, or /clear for a new task',
  )
  expect(coldPromptMessage(746_000, true)).toContain('/ai-memory-handoff before it lapses lets you /clear and resume')
})

function engine(on: On) {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  // What the cold-cache dialog answers (undefined: Esc), the commands run and the box's fills.
  const dialog: { answer?: string; questions: string[] } = { questions: [] }
  const commands: string[] = []
  const fills: string[] = []
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: 'D:\\repo' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { tokens: 705_010, window: 1_000_000, percent: 70.5 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 34, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() }],
      cost: { usd: 1.42 },
    },
  }))
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usage(700_000, 5_000) } as never
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const [q] = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions
    dialog.questions.push(`${q?.question} [${q?.options.map(o => o.label).join(' | ')}]`)
    if (dialog.answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: [q], answers: { [q?.question ?? '']: dialog.answer } } } as never
  })
  on('command.run', ($, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true, box: { text: e.text, cursor: e.text.length } } as never
  })
  return { clock, toasts, dialog, commands, fills }
}

// A prompt typed at the terminal while the session is idle.
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('a main-thread response starts the countdown, which a click details and which lapses cold', async ($, on) => {
  const { clock, toasts } = engine(on)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'cache-button' })).toBeUndefined()

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream);
  await stream.result
  await band.redraw()
  expect(JSON.stringify(await band.drawn({ in: 'cache-button' }))).toContain('● 60m')

  // A click toasts the details.
  await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'cache-button' })
  await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'cache-button' })
  expect(toasts.splice(0)).toEqual([expect.stringMatching(/^Prompt cache warm, lapses in 1h00m .* 705k tokens cached · TTL 1h/)])

  await $.prompt.submit(typed('warm'))
  expect(toasts).toEqual([])

  await clock.advance(61 * MIN)
  await band.redraw()
  expect(JSON.stringify(await band.drawn({ in: 'cache-button' }))).toContain('○ cold')

  await band.unmount()
})

test('a prompt typed over a cold cache is held until the person picks', async ($, on) => {
  const { clock, toasts, dialog, commands, fills } = engine(on)
  const warmUp = async () => {
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
    for await (const _ of stream);
    await stream.result
    await clock.advance(61 * MIN)
  }
  await warmUp()

  // Sent as is: the dialog asked, nothing else happens.
  dialog.answer = COLD_SEND
  expect(await $.prompt.submit(typed('one'))).toEqual({ text: 'one' })
  expect(dialog.questions).toEqual([
    'Prompt cache is cold: sending this prompt re-caches 705k tokens. What now? [Send anyway | Compact first | New conversation]',
  ])
  expect(toasts).toEqual([])

  // Compact first: held, compacted, back in the box; the stale mark goes, so no second ask.
  dialog.answer = COLD_COMPACT
  expect(await $.prompt.submit(typed('two'))).toEqual({ drop: 'Prompt held while the conversation compacts; it goes back to the prompt box' })
  await clock.advance(1)
  expect(commands).toEqual(['compact'])
  expect(fills).toEqual(['two'])
  expect(await $.prompt.submit(typed('two'))).toEqual({ text: 'two' })
  expect(dialog.questions).toHaveLength(2)

  // A new conversation: held, cleared, back in the box.
  await warmUp()
  dialog.answer = COLD_NEW
  expect((await $.prompt.submit(typed('three'))).drop).toContain('new conversation')
  await clock.advance(1)
  expect(commands).toEqual(['compact', 'clear'])
  expect(fills).toEqual(['two', 'three'])

  // Esc: back in the box unsent; the same text again goes, with the toast.
  await warmUp()
  dialog.answer = undefined
  expect((await $.prompt.submit(typed('four'))).drop).toContain('Enter sends it as is')
  await clock.advance(1)
  expect(commands).toEqual(['compact', 'clear'])
  expect(fills).toEqual(['two', 'three', 'four'])
  expect(await $.prompt.submit(typed('four'))).toEqual({ text: 'four' })
  expect(toasts.splice(0)).toEqual(['Prompt cache was cold: this prompt re-caches 705k tokens. Next time, /compact before it lapses, or /clear for a new task'])

  // A prompt the person did not type is never held.
  const asked = dialog.questions.length
  expect(await $.prompt.submit({ text: 'five', wait: false, origin: { kind: 'plugin', name: 'other' } } as never)).toEqual({ text: 'five' })
  expect(dialog.questions).toHaveLength(asked)
  expect(toasts).toHaveLength(1)
})

test('with ai-memory, a handoff precedes the new conversation', async () => {
  expect(coldChoices(true)).toEqual([COLD_SEND, COLD_COMPACT, COLD_HANDOFF, COLD_NEW])
  expect(coldCommands(COLD_HANDOFF)).toEqual(['ai-memory-handoff', 'clear'])
  expect(coldCommands(COLD_SEND)).toBeUndefined()
  expect(coldCommands('something typed')).toBeUndefined()
})

test('a known subscription keeps its windows until a response tells which it has', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { hasWindows: true })
  // The desktop counts the context before any response; the windows come with the first one.
  let rateLimits: { kind: string; percentUsed: number; resetsAt: string }[] = []
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: 'D:\repo' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 20_000, window: 1_000_000, percent: 2 }, rateLimits, cost: { usd: 0 } },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* () {
    rateLimits = [{ kind: 'five_hour', percentUsed: 3, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() }]
    return { turnId: 't1', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usage(0, 20_000) } as never
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: 'D:\repo', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'desktop', ...BAND })
  const drawn = async () => JSON.stringify(await band.drawn())
  expect(await drawn()).not.toContain('$0.00')
  expect(await drawn()).toContain('5h')
  expect(await drawn()).toContain('7d')

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream);
  await stream.result
  await band.redraw()
  // A plan with a 5h window alone: the 7d leaves, the cost stays away.
  expect(await drawn()).toContain('5h')
  expect(await drawn()).not.toContain('7d')
  expect(await drawn()).not.toContain('$0.00')
  await band.unmount()
})

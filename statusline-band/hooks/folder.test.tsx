import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const CWD = 'D:\\repos\\TEST\\claude-mods'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const WINDOWS = [
  { kind: 'five_hour', percentUsed: 21, resetsAt: new Date(NOW + 4 * 3600_000).toISOString() },
  { kind: 'seven_day', percentUsed: 22, resetsAt: new Date(NOW + 4 * 86_400_000).toISOString() },
]

function engine(on: On, isCopied = true, rateLimits: typeof WINDOWS = []) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const copied: string[] = []
  const toasts: string[] = []
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits, cost: { usd: 22.06 } },
  }))
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: isCopied ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' } } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { copied, toasts }
}

test('the folder shows its name, and its full path under the pointer', async ($, on) => {
  engine(on)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  const drawnText = async () => JSON.stringify(await band.drawn({ in: 'folder-button' }))
  expect(await drawnText()).toContain('📁 claude-mods')

  await band.pointer({ type: 'enter', x: 0, y: 0, in: 'folder-button' })
  expect(await drawnText()).toContain(JSON.stringify(CWD).slice(1, -1))

  await band.pointer({ type: 'leave', x: -1, y: 0, in: 'folder-button' })
  expect(await drawnText()).toContain('📁 claude-mods')
})

test('a click copies the full path and says so', async ($, on) => {
  const { copied, toasts } = engine(on)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'folder-button' })
  await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'folder-button' })
  expect(copied).toEqual([CWD])
  expect(toasts).toEqual([`Path copied: ${CWD}`])
})

test('a copy the surface refuses says why', async ($, on) => {
  const { toasts } = engine(on, false)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'folder-button' })
  await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'folder-button' })
  expect(toasts).toEqual(['Could not copy the path (no-clipboard)'])
})

test('on a subscription the windows stand in for the cost; a click swaps them, another swaps back', async ($, on) => {
  engine(on, true, WINDOWS)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  const usageText = async () => JSON.stringify(await band.drawn({ in: 'usage-button' }))
  const click = async () => {
    await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'usage-button' })
    await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'usage-button' })
  }
  expect(await usageText()).toContain('21%')
  expect(await usageText()).not.toContain('$22.06')

  // The pointer alone changes nothing.
  await band.pointer({ type: 'enter', x: 0, y: 0, in: 'usage-button' })
  expect(await usageText()).toContain('21%')

  await click()
  expect(await usageText()).toContain('$22.06')
  expect(await usageText()).toContain('API-equivalent')

  await click()
  expect(await usageText()).toContain('21%')
})

test('an API account shows the cost and no windows', async ($, on) => {
  engine(on)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'usage-button' })).toBeUndefined()
  expect(JSON.stringify(await band.drawn())).toContain('$22.06')
})

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { effortFromCommand, effortFromModelCommand } from './effort'

const NOW = Date.parse('2026-10-07T12:00:00Z')

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

function engine(
  on: On,
  modelOutput = 'Set model to `Opus 5.5` and saved as your default for new sessions with `xhigh` effort',
  model = () => 'claude-opus-5-5',
  onModelRun = () => {},
) {
  mock.clock(on, { now: NOW })
  const ran: string[] = []
  on('session.model', () => ({ value: model() }))
  on('session.cwd', () => ({ value: 'D:\\repo' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('command.run', ($, e) => {
    ran.push(`/${e.command}${e.args ? ' ' + e.args : ''}`)
    if (e.command === 'model') {
      onModelRun()
      return { text: modelOutput }
    }
    return { text: e.command === 'effort' ? `Set effort level to ${e.args} (saved as your default for new sessions): ...` : '' }
  })
  on('ui.toast', () => ({ value: undefined }))
  return { ran }
}

test('the level an /effort set is read from its output, else from its args', async () => {
  expect(effortFromCommand('low', 'Set effort level to low (saved as your default for new sessions): Quick')).toBe('low')
  expect(effortFromCommand('max', 'Set effort level to max (this session only): Maximum')).toBe('max')
  expect(effortFromCommand('auto', undefined)).toBe('auto')
  expect(effortFromCommand('', undefined)).toBeUndefined()
  expect(effortFromCommand('turbo', 'Invalid argument: turbo.')).toBeUndefined()
})

test('the model button runs /model with no arguments, opening the native picker', async ($, on) => {
  const { ran } = engine(on)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'model-button' })
  await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'model-button' })
  expect(ran).toEqual(['/model'])
})

test('a typed /effort shows on the band at once, before any model request', async ($, on) => {
  engine(on)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  await $.command.run({ command: 'effort', args: 'high' } as never)
  await band.redraw()
  expect(await band.find({ key: 'model-button' })).toMatchObject({ props: { props: { label: 'Opus 5.5 · high' } } })
})

test('the effort a /model left is read from its output', async () => {
  expect(effortFromModelCommand('Set model to `Opus 5.5` and saved as your default for new sessions with `medium` effort')).toBe('medium')
  expect(effortFromModelCommand('Set model to `Haiku 4.5` and saved as your default for new sessions')).toBeNull()
  expect(effortFromModelCommand('Kept model as `Opus 5.5`')).toBeUndefined()
  expect(effortFromModelCommand('Cancelled')).toBeUndefined()
  expect(effortFromModelCommand(undefined)).toBeUndefined()
})

test('the model button updates the effort the native picker left', async ($, on) => {
  engine(on)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'model-button' })
  await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'model-button' })
  await band.redraw()
  expect(await band.find({ key: 'model-button' })).toMatchObject({ props: { props: { label: 'Opus 5.5 · xhigh' } } })
})

test('the same model picked again without an effort keeps the level on the band', async ($, on) => {
  engine(on, 'Set model to `Opus 5.5` and saved as your default for new sessions')
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  await $.command.run({ command: 'effort', args: 'high' } as never)
  await $.command.run({ command: 'model' } as never)
  await band.redraw()
  expect(await band.find({ key: 'model-button' })).toMatchObject({ props: { props: { label: 'Opus 5.5 · high' } } })
})

test('a typed /model to a model without effort drops the effort from the band', async ($, on) => {
  let model = 'claude-opus-5-5'
  engine(
    on,
    'Set model to `Haiku 4.5` and saved as your default for new sessions',
    () => model,
    () => (model = 'claude-haiku-4-5-20251001'),
  )
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  await $.command.run({ command: 'effort', args: 'high' } as never)
  await $.command.run({ command: 'model', args: 'haiku' } as never)
  await band.redraw()
  expect(await band.find({ key: 'model-button' })).toMatchObject({ props: { props: { label: 'Haiku 4.5' } } })
})

test('the model text is drawn cyan and bold, white on cyan under the pointer', async ($, on) => {
  engine(on)
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  expect(await band.drawn({ in: 'model-button' })).toMatchObject({ type: 'Text', props: { color: 'cyan', bold: true } })
  await band.pointer({ type: 'enter', x: 0, y: 0, in: 'model-button' })
  expect(await band.drawn({ in: 'model-button' })).toMatchObject({ props: { color: 'white', backgroundColor: 'cyan' } })
  await band.pointer({ type: 'leave', x: -1, y: 0, in: 'model-button' })
  expect(await band.drawn({ in: 'model-button' })).toMatchObject({ props: { color: 'cyan' } })
})

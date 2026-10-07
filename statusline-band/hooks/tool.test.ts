import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-07T12:00:00Z')

function engine(on: On) {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, toasts }
}

test('a tool call passes through unchanged, and a long one toasts when it ends', async ($, on) => {
  const { clock, toasts } = engine(on)
  const seen: unknown[] = []
  on('tool.call', async ($, e) => {
    seen.push(e)
    await clock.advance(61_000)
    return { result: { stdout: 'done' }, text: 'done' } as never
  })

  const call = { tool: 'Bash', command: 'python calibrate.py', description: 'Run calibration' } as const
  const result = await $.tool.call(call as never)

  expect(result).toMatchObject({ text: 'done' })
  expect(seen[0]).toMatchObject(call)
  expect(toasts).toEqual(['✔ Bash: Run calibration finished in 1m01s'])
})

test('a long failed call toasts as failed', async ($, on) => {
  const { clock, toasts } = engine(on)
  on('tool.call', async () => {
    await clock.advance(61_000)
    return { result: { stdout: '' }, text: 'boom', isError: true } as never
  })

  await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  expect(toasts).toEqual(['✘ Bash: false finished in 1m01s'])
})

test('a short tool call does not toast', async ($, on) => {
  const { toasts } = engine(on)
  on('tool.call', async () => ({ result: { stdout: 'ok' }, text: 'ok' }) as never)

  await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  expect(toasts).toEqual([])
})

test('a call that throws leaves the band, and a long one toasts as failed', async ($, on) => {
  const { clock, toasts } = engine(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('tool.call', async () => {
    await clock.advance(61_000)
    throw new Error('interrupted')
  })

  await expect($.tool.call({ tool: 'Bash', command: 'sleep 100', description: 'Wait' } as never)).rejects.toThrow()
  expect(toasts).toEqual(['✘ Bash: Wait finished in 1m01s'])

  // Had it stayed in the list, the band would show it as running 61 s on.
  const band = await $.ui.mount({
    plugin: 'statusline-band',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  expect(JSON.stringify(await band.drawn())).not.toContain('▶')
})

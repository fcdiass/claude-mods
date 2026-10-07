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

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-07T12:00:00Z')

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

function engine(on: On) {
  mock.clock(on, { now: NOW })
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('session.cwd', () => ({ value: 'D:\\repo' }))
  on('session.usage', () => ({ value: {
    startedAt: NOW - 125_000,
    context: { tokens: 42_000, window: 200_000, percent: 21 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
    ],
    cost: { usd: 1.42 },
  } }))
  // What the engine draws when the band yields.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

test('the band draws both lines on the terminal and desktop', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'statusline-band', surface, ...BAND })
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    expect(JSON.stringify(await ui.drawn())).toContain('◆')
    // The model is clickable on the terminal alone, where /model opens a picker.
    if (surface === 'terminal') expect(await ui.find({ key: 'model-button' })).toBeDefined()
    else expect(await ui.find({ key: 'model-button' })).toBeUndefined()
    // A subscription: the windows stand in for the cost.
    expect(await ui.find({ type: 'Text', text: /\$1\.42/ })).toBeUndefined()
    expect(JSON.stringify(await ui.drawn({ in: 'reset-button-2' }))).toContain('↺ 3d00h')
    await ui.unmount()
  }
})

test('the band yields to a survey', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({
    plugin: 'statusline-band',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
  })
  expect(await ui.find({ type: 'Text', text: /◆/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()
})

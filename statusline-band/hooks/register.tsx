import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, SessionRateLimit } from 'claude-code'

import type { GitInfo, RunningTool } from '../types'
import { LONG_TOOL_MS, climb, gauges } from './alerts'
import { FIVE_HOUR_MS, SEVEN_DAY_MS, buildLines, contextAltSegs, costAltSegs, fmtDuration, projectByPace } from './format'
import type { Press, RateLimit, Seg } from './format'
import { effortFromCommand, effortFromModelCommand } from './effort'

const git = atom({ plugin: 'statusline-band', key: 'git' } as const, null)
const running = atom({ plugin: 'statusline-band', key: 'running' } as const, [])
const alerts = atom({ plugin: 'statusline-band', key: 'alerts' } as const, {})
const effort = atom({ plugin: 'statusline-band', key: 'effort' } as const, null)
const hasWindows = atom({ plugin: 'statusline-band', key: 'hasWindows' } as const, false)

// Kept across sessions: an account once seen with 5h/7d windows shows them from the first draw,
// before this session's first API response brings them.
const HAS_WINDOWS_KEY = 'hasWindows'

// The effort the settings give the model: its own modelSettings entry, else the global one.
async function settingsEffort($: EngineInterface): Promise<string | null> {
  const [settings, model] = await Promise.all([$.settings.read(), $.session.model()])
  const perModel = settings.modelSettings as Record<string, { effortLevel?: unknown }> | undefined
  const level = perModel?.[model]?.effortLevel ?? settings.effortLevel
  return typeof level === 'string' ? level : null
}

const WINDOW_MS = { five_hour: FIVE_HOUR_MS, seven_day: SEVEN_DAY_MS } as const
type WindowKind = keyof typeof WINDOW_MS

async function readGit($: EngineInterface, cwd: string): Promise<GitInfo | null> {
  const run = (...args: string[]) => $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 })
  try {
    const root = await run('rev-parse', '--show-toplevel')
    const head = await run('rev-parse', '--abbrev-ref', 'HEAD')
    if (root.exitCode !== 0 || head.exitCode !== 0) return null
    let branch = head.stdout.trim()
    if (branch === 'HEAD') {
      const sha = await run('rev-parse', '--short', 'HEAD')
      branch = '#' + sha.stdout.trim()
    }
    const repo = root.stdout.trim().replace(/\\/g, '/').split('/').pop() ?? ''
    return { repo, branch }
  } catch {
    return null
  }
}

function rateLimit(kind: WindowKind, limits: readonly SessionRateLimit[], nowMs: number): RateLimit | undefined {
  const limit = limits.find(l => l.kind === kind)
  if (!limit) return undefined
  const resetsAtMs = limit.resetsAt ? Date.parse(limit.resetsAt) : undefined
  const etaMs = projectByPace(limit.percentUsed, Number.isNaN(resetsAtMs) ? undefined : resetsAtMs, WINDOW_MS[kind], nowMs)
  return { percentUsed: limit.percentUsed, resetsAt: limit.resetsAt, etaMs }
}

// After a /model: the effort its output names; none named means no effort only when the model
// changed (the same model picked again keeps its level); no output reaching the mod means the
// settings' effort, since /model saves its pick as the default. The model name redraws too.
async function afterModelCommand($: EngineInterface, output: string | undefined, before: string): Promise<void> {
  const named = effortFromModelCommand(output)
  const isSameModel = (await $.session.model()) === before
  const level =
    output === undefined ? await settingsEffort($) : named === null && isSameModel ? undefined : named
  if (level !== undefined && (await read($, effort)) !== level) await update($, effort, () => level)
  $.ui.invalidate('ui.render')
}

// Opens Claude Code's own /model picker, as typing /model does; it runs once the session is idle.
// Copies the session's folder to the clipboard of the surface clicked, and says so in a toast.
async function copyPath($: EngineInterface, surface: RenderSurface): Promise<void> {
  const path = await $.session.cwd()
  const copied = await $.ui.copy({ text: path, surface })
  $.ui.toast(copied.isCopied ? `Path copied: ${path}` : `Could not copy the path (${copied.reason})`, {
    timeoutMs: 5000,
  })
}

async function openModelPicker($: EngineInterface): Promise<void> {
  try {
    const before = await $.session.model()
    const result = await $.command.run({ command: 'model' })
    // This plugin's own command.run hooks skip its own runs, so the band is updated here.
    await afterModelCommand($, result.text, before)
  } catch (error) {
    $.ui.toast(`/model failed: ${String(error)}`, { timeoutMs: 8000 })
  }
}

function labelOf(e: { tool: string }): string {
  const fields = e as { description?: unknown; command?: unknown }
  const detail =
    typeof fields.description === 'string' && fields.description
      ? fields.description
      : typeof fields.command === 'string'
        ? fields.command
        : ''
  const short = detail.length > 40 ? detail.slice(0, 39) + '…' : detail
  return short ? `${e.tool}: ${short}` : e.tool
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // Until the first model request says which effort it carries.
    if ((await read($, effort)) === null) {
      const fromSettings = await settingsEffort($).catch(() => null)
      await update($, effort, () => fromSettings)
    }

    if ((await $.store.get(HAS_WINDOWS_KEY).catch(() => undefined)) === true) await update($, hasWindows, () => true)

    // git runs here on a timer, never while drawing.
    const refreshGit = async () => {
      const info = await readGit($, await $.session.cwd())
      const current = await read($, git)
      if (JSON.stringify(info) !== JSON.stringify(current)) await update($, git, () => info)
    }

    // Toasts once per climb past a threshold (context, 5h/7d pace, projection).
    const checkAlerts = async () => {
      const [usage, nowMs, previous, isKnown] = await Promise.all([
        $.session.usage(),
        $.clock.now(),
        read($, alerts),
        read($, hasWindows),
      ])
      if (usage.rateLimits.length > 0 && !isKnown) {
        await update($, hasWindows, () => true)
        await $.store.set(HAS_WINDOWS_KEY, true)
      }
      const { toasts, levels } = climb(
        previous,
        gauges({
          contextPercent: usage.context.percent,
          fiveHour: rateLimit('five_hour', usage.rateLimits, nowMs),
          sevenDay: rateLimit('seven_day', usage.rateLimits, nowMs),
          nowMs,
        }),
      )
      for (const text of toasts) $.ui.toast(text, { timeoutMs: 8000 })
      if (JSON.stringify(levels) !== JSON.stringify(previous)) await update($, alerts, () => levels)
    }

    await refreshGit()
    $.clock.every(5000, () => void Promise.all([refreshGit(), checkAlerts()]).catch(() => {}))

    // Duration, countdowns and the running tool's time move with the clock.
    $.clock.every(1000, () => $.ui.invalidate('ui.render'))

    return result
  })

  // Reads the effort each main-thread model request carries (none for a model without effort);
  // the request goes on unchanged.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      try {
        const level = e.effort === undefined ? null : String(e.effort)
        if ((await read($, effort)) !== level) await update($, effort, () => level)
      } catch {
        // The request is sent whatever happened to the band.
      }
    }
    return yield* next(e)
  })

  // A typed /effort shows on the band as soon as it has run.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const level = effortFromCommand(e.args, result.text)
      if (level && (await read($, effort)) !== level) await update($, effort, () => level)
    } catch {
      // The command's output is returned whatever happened to the band.
    }
    return result
  })

  // Clicks on the band's Clients: the model text opens the /model picker, the folder copies its path.
  on('ui.message', ($, e, next) => {
    const data = e.data as { open?: unknown; action?: unknown } | null
    if (e.element === 'model-button' && data?.open === 'model') void openModelPicker($)
    if (e.element === 'folder-button' && data?.action === 'copy-path') void copyPath($, e.surface)
    return next(e)
  })

  // A typed /model shows its model and effort on the band as soon as it has run.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const before = await $.session.model().catch(() => '')
    const result = await next(e)
    try {
      await afterModelCommand($, result.text, before)
    } catch {
      // The command's output is returned whatever happened to the band.
    }
    return result
  })

  // Observes every tool call without changing it: the band shows what is running,
  // and a call that ran a minute or more toasts when it ends.
  on('tool.call', async ($, e, next) => {
    let entry: RunningTool | undefined
    try {
      const startedAt = await $.clock.now()
      entry = { id: e.tool_use_id ?? `${e.tool}@${startedAt}`, label: labelOf(e), startedAt }
      const added = entry
      await update($, running, list => [...list, added])
    } catch {
      entry = undefined
    }

    const result = await next(e)

    if (entry) {
      const done = entry
      try {
        await update($, running, list => list.filter(r => r.id !== done.id))
        const ms = (await $.clock.now()) - done.startedAt
        if (ms >= LONG_TOOL_MS) {
          const isOk = result.deny === undefined && result.isError !== true
          $.ui.toast(`${isOk ? '✔' : '✘'} ${done.label} finished in ${fmtDuration(ms)}`, { timeoutMs: 8000 })
        }
      } catch {
        // The result is returned whatever happened to the band.
      }
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const [model, cwd, usage, nowMs, gitInfo, inFlight, effortLevel, isKnownSubscription] = await Promise.all([
      $.session.model(),
      $.session.cwd(),
      $.session.usage(),
      $.clock.now(),
      read($, git),
      read($, running),
      read($, effort),
      read($, hasWindows),
    ])

    const oldest = inFlight[0]
    const lines = buildLines({
      model,
      effort: effortLevel,
      cwd,
      git: gitInfo,
      contextPercent: usage.context.percent,
      costUsd: usage.cost?.usd,
      hasWindows: isKnownSubscription || usage.rateLimits.length > 0,
      fiveHour: rateLimit('five_hour', usage.rateLimits, nowMs),
      sevenDay: rateLimit('seven_day', usage.rateLimits, nowMs),
      running: oldest ? { label: oldest.label, startedAt: oldest.startedAt, count: inFlight.length } : undefined,
      nowMs,
    })

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements

    const styled = (segs: Seg[]) =>
      segs.map(s => (
        <Text color={s.color} bold={s.bold} dimColor={s.dim}>
          {s.text}
        </Text>
      ))

    // Plain runs of a line are Text; a pressable segment is a Button with no chrome.
    const row = (segs: Seg[]) => {
      const parts: JSX.Element[] = []
      let run: Seg[] = []
      const flush = () => {
        if (run.length > 0) parts.push(<Text wrap="truncate-end">{styled(run)}</Text>)
        run = []
      }
      // A Client's props are plain JSON: a style a segment lacks is left out, not undefined.
      const toParts = (group: Seg[]) =>
        group.map(({ text, color, bold, dim, underline }) => ({
          text,
          ...(color !== undefined && { color }),
          ...(bold !== undefined && { bold }),
          ...(dim !== undefined && { dim }),
          ...(underline !== undefined && { underline }),
        }))

      // Consecutive segments pressed alike make one element. Terminal and desktop draw it in its
      // colors through a Client; elsewhere the model and folder are plain Buttons, the windows Text.
      const pressable = (press: Press, group: Seg[]) => {
        const label = group.map(seg => seg.text).join('')
        if ('Client' in elements) {
          const { Client } = elements
          if (press === 'model') {
            return <Client key="model-button" module="./model-button.tsx" props={{ label, color: group[0]?.color ?? 'cyan' }} />
          }
          const swap =
            press === 'folder'
              ? { key: 'folder-button', trigger: 'hover' as const, alt: [{ text: `📂 ${cwd}`, color: 'white', underline: true }], action: 'copy-path' }
              : press === 'usage'
                ? { key: 'usage-button', trigger: 'click' as const, alt: costAltSegs(usage.cost?.usd) }
                : {
                    key: 'context-button',
                    trigger: 'click' as const,
                    alt: contextAltSegs(usage.context.percent, usage.context.tokens, usage.context.window),
                  }
          return (
            <Client
              key={swap.key}
              module="./swap-button.tsx"
              props={{
                parts: toParts(group),
                altParts: toParts(swap.alt),
                trigger: swap.trigger,
                ...('action' in swap && { action: swap.action }),
              }}
            />
          )
        }
        if (press === 'model') return <Button key="open-model" plain label={label} onPress={() => void openModelPicker($)} />
        if (press === 'folder') {
          return <Button key="copy-path" plain label={label} onPress={press => void copyPath($, press.surface)} />
        }
        return <Text wrap="truncate-end">{styled(group)}</Text>
      }

      for (let i = 0; i < segs.length; ) {
        const press = segs[i]?.press
        if (press === undefined) {
          run.push(segs[i] as Seg)
          i += 1
          continue
        }
        flush()
        let j = i
        while (j < segs.length && segs[j]?.press === press) j += 1
        parts.push(pressable(press, segs.slice(i, j)))
        i = j
      }
      flush()
      return <Box flexDirection="row">{parts}</Box>
    }

    return (
      <Box flexDirection="column" marginTop={1}>
        {lines.map(row)}
      </Box>
    )
  })

}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, SessionRateLimit, SessionUsage } from 'claude-code'

import type { GitInfo, RunningTool } from '../types'
import { HANDOFF_SKILL, LONG_TOOL_MS, cacheDetailsMessage, cacheExpiryMessage, climb, coldPromptMessage, gauges } from './alerts'
import { CACHE_ALERT_TOKENS, cacheStatus, cacheTtl, isExpiryDue, recordStep, ttlOverride } from './cache'
import type { CacheStatus } from './cache'
import {
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  accountHasWindows,
  buildLines,
  contextAltSegs,
  fmtDuration,
  projectByPace,
} from './format'
import type { Press, RateLimit, Seg } from './format'
import { effortFromCommand, effortFromModelCommand } from './effort'
import { parseGitStatus } from './git'

const git = atom({ plugin: 'statusline-band', key: 'git' } as const, null)
const running = atom({ plugin: 'statusline-band', key: 'running' } as const, [])
const alerts = atom({ plugin: 'statusline-band', key: 'alerts' } as const, {})
const effort = atom({ plugin: 'statusline-band', key: 'effort' } as const, null)
const hasWindows = atom({ plugin: 'statusline-band', key: 'hasWindows' } as const, false)
const compactAt = atom({ plugin: 'statusline-band', key: 'compactAt' } as const, null)
const showCost = atom({ plugin: 'statusline-band', key: 'showCost' } as const, false)
const showResetAt = atom({ plugin: 'statusline-band', key: 'showResetAt' } as const, false)
const cache = atom({ plugin: 'statusline-band', key: 'cache' } as const, null)
const forcedTtl = atom({ plugin: 'statusline-band', key: 'ttlOverride' } as const, null)
const hasHandoff = atom({ plugin: 'statusline-band', key: 'hasHandoff' } as const, false)

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

// --no-optional-locks: the status every 5 s never holds the index lock a git of the person's needs.
async function readGit($: EngineInterface, cwd: string): Promise<GitInfo | null> {
  const run = (...args: string[]) =>
    $.process.run(['git', '--no-optional-locks', '-C', cwd, ...args], { timeoutMs: 5000 })
  try {
    const root = await run('rev-parse', '--show-toplevel')
    if (root.exitCode !== 0) return null
    const status = await run('status', '--porcelain=v2', '--branch')
    if (status.exitCode !== 0) return null
    const repo = root.stdout.trim().replace(/\\/g, '/').split('/').pop() ?? ''
    return { repo, ...parseGitStatus(status.stdout) }
  } catch {
    return null
  }
}

// The token count at which auto-compaction runs, as /context reckons it (estimated locally, no
// request sent); null when it is off. It changes with the model, so a /model reads it again.
async function refreshCompactAt($: EngineInterface): Promise<void> {
  try {
    const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
    const threshold = breakdown?.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null
    if ((await read($, compactAt)) !== threshold) await update($, compactAt, () => threshold)
  } catch {
    // The band goes on without the mark.
  }
}

// What may change the cache's TTL or the toasts' advice: the settings, the environment, and
// whether ai-memory's handoff skill is installed. Read with the compaction mark, every minute.
async function refreshCacheConfig($: EngineInterface): Promise<void> {
  try {
    const [settings, force5m, envTtl, enable1h, commands] = await Promise.all([
      $.settings.read(),
      $.env.get('FORCE_PROMPT_CACHING_5M'),
      $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      $.env.get('ENABLE_PROMPT_CACHING_1H'),
      $.command.list().catch(() => []),
    ])
    const ttl = ttlOverride({ force5m, envTtl, settingTtl: settings.promptCacheTtl, enable1h })
    if ((await read($, forcedTtl)) !== ttl) await update($, forcedTtl, () => ttl)
    const isHandoff = commands.some(c => c.name === HANDOFF_SKILL)
    if ((await read($, hasHandoff)) !== isHandoff) await update($, hasHandoff, () => isHandoff)
  } catch {
    // The account's default TTL and the plain advice stand.
  }
}

// The cache as of now: its TTL from the settings, else from the account (a window used up means
// usage credits, on the shorter TTL).
async function readCache($: EngineInterface, usage: SessionUsage, nowMs: number): Promise<CacheStatus | undefined> {
  const [mark, override, isKnown, model] = await Promise.all([read($, cache), read($, forcedTtl), read($, hasWindows), $.session.model()])
  const isPastWindow = usage.rateLimits.some(l => (l.percentUsed ?? 0) >= 100)
  const ttl = cacheTtl(override, accountHasWindows(isKnown, usage.rateLimits.length, usage.context.tokens), isPastWindow)
  return cacheStatus(mark, ttl, model, nowMs)
}

// A click on the cache's countdown toasts its details.
async function showCacheDetails($: EngineInterface): Promise<void> {
  try {
    const [usage, nowMs] = await Promise.all([$.session.usage(), $.clock.now()])
    const status = await readCache($, usage, nowMs)
    if (status) $.ui.toast(cacheDetailsMessage(status, nowMs), { timeoutMs: 15_000 })
  } catch {
    // Nothing to show.
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
  await refreshCompactAt($)
  $.ui.invalidate('ui.render')
}

// Copies the session's folder to the clipboard of the surface clicked, and says so in a toast.
async function copyPath($: EngineInterface, surface: RenderSurface): Promise<void> {
  const path = await $.session.cwd()
  const copied = await $.ui.copy({ text: path, surface })
  $.ui.toast(copied.isCopied ? `Path copied: ${path}` : `Could not copy the path (${copied.reason})`, {
    timeoutMs: 5000,
  })
}

// Shows Claude Code's own /context breakdown, as typing /context does.
async function openContext($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'context' })
  } catch (error) {
    $.ui.toast(`/context failed: ${String(error)}`, { timeoutMs: 8000 })
  }
}

// Opens Claude Code's own /model picker, as typing /model does; it runs once the session is idle.
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
      const isSubscription = accountHasWindows(isKnown, usage.rateLimits.length, usage.context.tokens)
      if (isSubscription !== isKnown) {
        await update($, hasWindows, () => isSubscription)
        await $.store.set(HAS_WINDOWS_KEY, isSubscription)
      }
      const threshold = await read($, compactAt)
      const { toasts, levels } = climb(
        previous,
        gauges({
          contextPercent: usage.context.percent,
          compactAtPercent: threshold === null ? undefined : (threshold / usage.context.window) * 100,
          fiveHour: rateLimit('five_hour', usage.rateLimits, nowMs),
          sevenDay: rateLimit('seven_day', usage.rateLimits, nowMs),
          nowMs,
        }),
      )
      for (const text of toasts) $.ui.toast(text, { timeoutMs: 8000 })
      if (JSON.stringify(levels) !== JSON.stringify(previous)) await update($, alerts, () => levels)

      // Once per response, a large prefix toasts a few minutes before its cache lapses.
      const status = await readCache($, usage, nowMs)
      if (status && isExpiryDue(status) && (await read($, cache))?.isExpiryWarned === false) {
        await update($, cache, mark => (mark ? { ...mark, isExpiryWarned: true } : mark))
        $.ui.toast(cacheExpiryMessage(status.remainingMs, status.tokens, await read($, hasHandoff)), { timeoutMs: 60_000 })
      }
    }

    await refreshGit()
    await refreshCompactAt($)
    await refreshCacheConfig($)
    $.clock.every(60_000, () => void Promise.all([refreshCompactAt($), refreshCacheConfig($)]))
    $.clock.every(5000, () => void Promise.all([refreshGit(), checkAlerts()]).catch(() => {}))

    // The reset countdowns and the running tool's time move with the clock.
    $.clock.every(1000, () => $.ui.invalidate('ui.render'))

    return result
  })

  // Reads the effort each main-thread model request carries (none for a model without effort),
  // and what its response tells of the prompt cache; the request goes on unchanged.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    try {
      const level = e.effort === undefined ? null : String(e.effort)
      if ((await read($, effort)) !== level) await update($, effort, () => level)
    } catch {
      // The request is sent whatever happened to the band.
    }
    const result = yield* next(e)
    try {
      const usage = result.usage
      if (usage) {
        const nowMs = await $.clock.now()
        await update($, cache, mark => recordStep(mark, usage, nowMs))
      }
    } catch {
      // The response is returned whatever happened to the band.
    }
    return result
  })

  // A prompt sent while idle over a cold cache of a large prefix toasts what it re-caches.
  // It goes out unchanged; a prompt typed mid-turn rides a warm cache.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      try {
        const status = await readCache($, await $.session.usage(), await $.clock.now())
        if (status && status.remainingMs <= 0 && status.tokens >= CACHE_ALERT_TOKENS) {
          $.ui.toast(coldPromptMessage(status.tokens, await read($, hasHandoff)), { timeoutMs: 15_000 })
        }
      } catch {
        // The prompt is sent whatever happened to the band.
      }
    }
    return next(e)
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

  // Clicks on the band's Clients: the model text opens the /model picker, ctx opens /context,
  // the folder copies its path, the windows swap for the cost and a reset for its clock time.
  on('ui.message', ($, e, next) => {
    const data = e.data as { open?: unknown; action?: unknown } | null
    if (e.element === 'model-button' && data?.open === 'model') void openModelPicker($)
    if (e.element === 'context-label' && data?.open === 'context') void openContext($)
    if (e.element === 'folder-button' && data?.action === 'copy-path') void copyPath($, e.surface)
    if (data?.action === 'toggle-cost') void update($, showCost, isShown => !isShown)
    if (data?.action === 'toggle-reset') void update($, showResetAt, isShown => !isShown)
    if (data?.action === 'cache-details') void showCacheDetails($)
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

    let result: Awaited<ReturnType<typeof next>> | undefined
    try {
      result = await next(e)
      return result
    } finally {
      // A call that threw (one interrupted, say) leaves the band too, and a long one toasts as failed.
      if (entry) {
        const done = entry
        try {
          await update($, running, list => list.filter(r => r.id !== done.id))
          const ms = (await $.clock.now()) - done.startedAt
          if (ms >= LONG_TOOL_MS) {
            const isOk = result !== undefined && result.deny === undefined && result.isError !== true
            $.ui.toast(`${isOk ? '✔' : '✘'} ${done.label} finished in ${fmtDuration(ms)}`, { timeoutMs: 8000 })
          }
        } catch {
          // The result is returned whatever happened to the band.
        }
      }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const [model, cwd, usage, nowMs, gitInfo, inFlight, effortLevel, isKnownSubscription, threshold, isCostShown, isResetAtShown] =
      await Promise.all([
      $.session.model(),
      $.session.cwd(),
      $.session.usage(),
      $.clock.now(),
      read($, git),
      read($, running),
      read($, effort),
      read($, hasWindows),
      read($, compactAt),
      read($, showCost),
      read($, showResetAt),
    ])

    const cacheNow = await readCache($, usage, nowMs).catch(() => undefined)
    const oldest = inFlight[0]
    const lines = buildLines({
      model,
      effort: effortLevel,
      cwd,
      git: gitInfo,
      contextPercent: usage.context.percent,
      compactAtPercent: threshold === null ? undefined : (threshold / usage.context.window) * 100,
      costUsd: usage.cost?.usd,
      hasWindows: accountHasWindows(isKnownSubscription, usage.rateLimits.length, usage.context.tokens),
      fiveHour: rateLimit('five_hour', usage.rateLimits, nowMs),
      sevenDay: rateLimit('seven_day', usage.rateLimits, nowMs),
      running: oldest ? { label: oldest.label, startedAt: oldest.startedAt, count: inFlight.length } : undefined,
      showCost: isCostShown,
      showResetAt: isResetAtShown,
      cache: cacheNow,
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

    // The first element of a kind takes its name as key, later ones a count: usage-button, usage-button-2.
    const keyCounts: Record<string, number> = {}
    const keyOf = (name: string) => {
      const n = (keyCounts[name] = (keyCounts[name] ?? 0) + 1)
      return n === 1 ? name : `${name}-${n}`
    }

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
        // Only the terminal's /model opens a picker; elsewhere it prints its usage, and the
        // desktop app has a model picker of its own, so the model stays plain colored text.
        if (press === 'model' && e.surface !== 'terminal') return <Text wrap="truncate-end">{styled(group)}</Text>
        if ('Client' in elements) {
          const { Client } = elements
          if (press === 'model') {
            return (
              <Client
                key="model-button"
                module="./command-button.tsx"
                props={{ label, command: 'model', color: group[0]?.color ?? 'cyan', bold: true }}
              />
            )
          }
          if (press === 'context-label') {
            return <Client key="context-label" module="./command-button.tsx" props={{ label, command: 'context' }} />
          }
          // The windows and their resets are split by the resets into several elements, so they
          // swap through the mod's state, all at once; each element only posts its click.
          if (press === 'usage' || press === 'reset' || press === 'cache') {
            const key = keyOf(press === 'usage' ? 'usage-button' : press === 'reset' ? 'reset-button' : 'cache-button')
            const action = press === 'usage' ? 'toggle-cost' : press === 'reset' ? 'toggle-reset' : 'cache-details'
            return (
              <Client
                key={key}
                module="./swap-button.tsx"
                props={{ parts: toParts(group), altParts: toParts(group), trigger: 'none', action, isHoverInverse: true }}
              />
            )
          }
          // On the desktop the longer path reflows the band under the pointer, which then leaves and
          // re-enters the folder in a loop; there a click copies and the toast shows the path.
          const folderTrigger: 'hover' | 'none' = e.surface === 'terminal' ? 'hover' : 'none'
          const swap =
            press === 'folder'
              ? { key: 'folder-button', trigger: folderTrigger, alt: [{ text: `📂 ${cwd}`, color: 'white', underline: true }], action: 'copy-path' }
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
                ...(press === 'context' && { isHoverInverse: true }),
              }}
            />
          )
        }
        if (press === 'model') return <Button key="open-model" plain label={label} onPress={() => void openModelPicker($)} />
        if (press === 'context-label') return <Button key="open-context" plain label={label} onPress={() => void openContext($)} />
        if (press === 'cache') return <Button key="cache-details" plain label={label} onPress={() => void showCacheDetails($)} />
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

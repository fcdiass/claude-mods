import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, SessionRateLimit, SessionUsage } from 'claude-code'

import type { ChangedFile, GitChanges, GitInfo, HostTools } from '../types'
import {
  COLD_SEND,
  HANDOFF_SKILL,
  cacheDetailsMessage,
  cacheExpiryMessage,
  climb,
  coldChoices,
  coldCommands,
  coldPromptMessage,
  coldQuestion,
  gauges,
  heldMessage,
} from './alerts'
import { CACHE_ALERT_TOKENS, cacheStatus, cacheTtl, isExpiryDue, recordStep, ttlOverride } from './cache'
import type { CacheStatus } from './cache'
import {
  C,
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  accountHasWindows,
  buildLines,
  contextAltSegs,
  projectByPace,
} from './format'
import type { Press, RateLimit, Seg } from './format'
import { effortFromCommand, effortFromModelCommand } from './effort'
import { parseGitStatus, readOperation } from './git'
import { parseDiff } from './changes'
import { actionArgv, menuItems } from './host'
import type { MenuItem } from './host'
import { CHOICES, SETTING_ROWS, nextValue, readSettings, toastLevel } from './settings'
import type { SettingKey, Settings } from './settings'

const git = atom({ plugin: 'statusline-band', key: 'git' } as const, null)
const alerts = atom({ plugin: 'statusline-band', key: 'alerts' } as const, {})
const effort = atom({ plugin: 'statusline-band', key: 'effort' } as const, null)
const hasWindows = atom({ plugin: 'statusline-band', key: 'hasWindows' } as const, false)
const compactAt = atom({ plugin: 'statusline-band', key: 'compactAt' } as const, null)
const showCost = atom({ plugin: 'statusline-band', key: 'showCost' } as const, false)
const showResetAt = atom({ plugin: 'statusline-band', key: 'showResetAt' } as const, false)
const cache = atom({ plugin: 'statusline-band', key: 'cache' } as const, null)
const forcedTtl = atom({ plugin: 'statusline-band', key: 'ttlOverride' } as const, null)
const hasHandoff = atom({ plugin: 'statusline-band', key: 'hasHandoff' } as const, false)
const heldPrompt = atom({ plugin: 'statusline-band', key: 'heldPrompt' } as const, null)
const changes = atom({ plugin: 'statusline-band', key: 'changes' } as const, null)
const host = atom({ plugin: 'statusline-band', key: 'host' } as const, null)

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
    const root = await run('rev-parse', '--show-toplevel', '--absolute-git-dir')
    if (root.exitCode !== 0) return null
    const [top = '', gitDir = ''] = root.stdout.trim().split(/\r?\n/)
    const status = await run('status', '--porcelain=v2', '--branch', '--show-stash')
    if (status.exitCode !== 0) return null
    const repo = top.replace(/\\/g, '/').split('/').pop() ?? ''
    const reader = { exists: (path: string) => $.fs.exists(path), read: (path: string) => $.fs.read(path) as Promise<string> }
    const under = gitDir ? await readOperation(gitDir, reader).catch(() => null) : null
    return { repo, ...parseGitStatus(status.stdout), ...(under && { operation: under.operation }), ...(under?.branch && { branch: under.branch }) }
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
  const ttl = cacheTtl(override, accountHasWindows(isKnown, usage.rateLimits.length, mark !== null), isPastWindow)
  return cacheStatus(mark, ttl, model, nowMs)
}

// After a held prompt's choice: its commands, then the prompt back in the box. A compaction or a
// new conversation leaves no cache to count down, so the mark goes with it.
async function afterHold($: EngineInterface, text: string, commands: readonly string[]): Promise<void> {
  try {
    for (const command of commands) await $.command.run({ command })
    if (commands.length > 0) await update($, cache, () => null)
  } catch {
    // The prompt still goes back to the box.
  }
  await $.prompt.fill({ text }).catch(() => undefined)
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

// The folder's menu and the changes pane: what a click on the folder's name and on a
// repository's files changed opens.

const MENU_PANE = 'folder-menu'
const CHANGES_PANE = 'git-changes'
const UNTRACKED_SHOWN = 50

const STATUS_COLOR: Record<ChangedFile['status'], string> = { A: C.GR, D: C.RD, M: C.YL, R: C.CY }

// Copies the session's folder to the clipboard of the surface clicked, and says so in a toast.
async function copyPath($: EngineInterface, surface?: RenderSurface): Promise<void> {
  const path = await $.session.cwd()
  const copied = await $.ui.copy({ text: path, ...(surface && { surface }) })
  $.ui.toast(copied.isCopied ? `Path copied: ${path}` : `Could not copy the path (${copied.reason})`, {
    timeoutMs: 5000,
  })
}

// The machine's platform and which of the menu's programs it has, looked up once.
async function findHost($: EngineInterface): Promise<HostTools> {
  const known = await read($, host)
  if (known) return known
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const has = async (name: string) => {
    const argv = isWindows ? ['where.exe', name] : ['sh', '-c', `command -v ${name}`]
    const found = await $.process.run(argv, { timeoutMs: 5000 }).catch(() => undefined)
    return found?.exitCode === 0
  }
  const uname = isWindows ? '' : await $.process.run(['uname', '-s'], { timeoutMs: 5000 }).then(r => r.stdout.trim(), () => '')
  const platform: HostTools['platform'] = isWindows ? 'windows' : uname === 'Darwin' ? 'mac' : 'linux'
  const [hasCode, hasWt] = await Promise.all([has('code'), isWindows ? has('wt') : Promise.resolve(false)])
  const found: HostTools = { platform, hasCode, hasWt }
  await update($, host, () => found)
  return found
}

async function runAction($: EngineInterface, item: MenuItem, surface?: RenderSurface): Promise<void> {
  await $.ui.close({ id: MENU_PANE }).catch(() => undefined)
  if (item.action === 'copy') return copyPath($, surface)
  try {
    const [tools, cwd] = await Promise.all([findHost($), $.session.cwd()])
    const run = actionArgv(item.action, tools, cwd)
    if (!run) return
    const result = await $.process.run(run.argv, { timeoutMs: 15_000, ...(run.cwd && { cwd: run.cwd }) })
    // Explorer exits 1 even when it opened the folder.
    const isExplorer = item.action === 'files' && tools.platform === 'windows'
    if (result.exitCode !== 0 && !isExplorer) {
      $.ui.toast(`${item.label} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`, { timeoutMs: 8000 })
    }
  } catch (error) {
    $.ui.toast(`${item.label} failed: ${String(error)}`, { timeoutMs: 8000 })
  }
}

// A click on the folder's name: its menu in a pane, keyed 1-4; where the surface places no pane,
// the same choices in a dialog.
async function openFolderMenu($: EngineInterface): Promise<void> {
  try {
    const items = menuItems(await findHost($))
    const opened = await $.ui.open({ id: MENU_PANE, title: 'Folder', focus: true, closeOnEscape: true, rows: items.length + 1 })
    if (opened.isPlaced) return
    await $.ui.close({ id: MENU_PANE }).catch(() => undefined)
    const choice = await $.ui.ask(`What to do with ${await $.session.cwd()}?`, {
      header: 'Folder',
      options: items.map(item => item.label),
    })
    const item = items.find(one => one.label === choice)
    if (item) await runAction($, item)
  } catch {
    // Dismissed, or nothing could open: the band stays as it was.
  }
}

// The working tree against HEAD (against nothing before the first commit), and the untracked files.
async function refreshChanges($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const git = (...args: string[]) =>
    $.process.run(['git', '-c', 'core.quotePath=false', '--no-optional-locks', '-C', cwd, ...args], { timeoutMs: 10_000 })
  let diff = await git('diff', 'HEAD', '--no-color', '--no-ext-diff')
  if (diff.exitCode !== 0) diff = await git('diff', '--no-color', '--no-ext-diff')
  const others = await git('ls-files', '--others', '--exclude-standard')
  const { files, isCut } = parseDiff(diff.exitCode === 0 ? diff.stdout : '')
  const untracked = others.exitCode === 0 ? others.stdout.split(/\r?\n/).filter(Boolean) : []
  const next: GitChanges = { files, untracked, isCut }
  if (JSON.stringify(next) !== JSON.stringify(await read($, changes))) await update($, changes, () => next)
}

// A click on the files changed: their diff in a pane.
async function openChanges($: EngineInterface): Promise<void> {
  try {
    await refreshChanges($)
    const opened = await $.ui.open({ id: CHANGES_PANE, title: 'Changes', focus: true, closeOnEscape: true })
    if (!opened.isPlaced) $.ui.toast('The changes pane cannot open on this surface; git diff shows them', { timeoutMs: 8000 })
  } catch (error) {
    $.ui.toast(`Could not read the changes: ${String(error)}`, { timeoutMs: 8000 })
  }
}

// While the changes pane is open it follows the working tree, on the band's git refresh.
async function refreshOpenChanges($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes().catch(() => [])
  if (panes.some(pane => pane.id === CHANGES_PANE)) await refreshChanges($).catch(() => undefined)
}

// The band's settings: a click on the diamond opens them in a pane, one row a setting, keyed
// 1-4; a press moves the row to its next value. The change goes through /config, which reloads
// the module with it, so the band and the pane redraw from the new options.

const SETTINGS_PANE = 'band-settings'

// The /config row of a field: its key names the plugin as the loader does (`statusline-band@<marketplace>`
// installed, `statusline-band` from a folder), so it is looked up, never spelled.
async function settingRow($: EngineInterface, key: SettingKey): Promise<string | undefined> {
  const rows = await $.config.list()
  const ours = rows.filter(row => row.provider.plugin === 'statusline-band' || row.key.startsWith('statusline-band'))
  return ours.find(row => row.key.endsWith(`.${key}`))?.key
}

async function changeSetting($: EngineInterface, key: SettingKey, value: string): Promise<void> {
  try {
    const row = await settingRow($, key)
    if (row === undefined) {
      $.ui.toast(`Could not change the setting: /config has no row for ${key}`, { timeoutMs: 8000 })
      return
    }
    const result = await $.config.set({ key: row, value })
    if (result.deny !== undefined) $.ui.toast(`Could not change the setting: ${result.deny}`, { timeoutMs: 8000 })
  } catch (error) {
    $.ui.toast(`Could not change the setting: ${String(error)}`, { timeoutMs: 8000 })
  }
}

// Where the surface places no pane, the same in two dialogs: which setting, then its value.
async function openSettings($: EngineInterface, settings: Settings): Promise<void> {
  try {
    const opened = await $.ui.open({ id: SETTINGS_PANE, title: 'Band settings', focus: true, closeOnEscape: true, rows: SETTING_ROWS.length })
    if (opened.isPlaced) return
    await $.ui.close({ id: SETTINGS_PANE }).catch(() => undefined)
    const rowLabel = (row: (typeof SETTING_ROWS)[number]) => `${row.label}: ${settings[row.key]}`
    const picked = await $.ui.ask('Which band setting to change?', { header: 'Band', options: SETTING_ROWS.map(rowLabel) })
    const row = SETTING_ROWS.find(one => rowLabel(one) === picked)
    if (!row) return
    const value = await $.ui.ask(`${row.label}: which value?`, { header: 'Band', options: [...CHOICES[row.key]] })
    if (value && value !== settings[row.key]) await changeSetting($, row.key, value)
  } catch {
    // Dismissed, or nothing could open: the settings stay.
  }
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

export const register: Register = (on, options) => {
  // A change in /config reloads the module with the new options.
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // Until the first model request says which effort it carries.
    if ((await read($, effort)) === null) {
      const fromSettings = await settingsEffort($).catch(() => null)
      await update($, effort, () => fromSettings)
    }

    if ((await $.store.get(HAS_WINDOWS_KEY).catch(() => undefined)) === true) await update($, hasWindows, () => true)

    // git runs here on a timer, never while drawing; with git off, never.
    const refreshGit = async () => {
      const info = settings.git === 'off' ? null : await readGit($, await $.session.cwd())
      const current = await read($, git)
      if (JSON.stringify(info) !== JSON.stringify(current)) await update($, git, () => info)
      if (settings.git === 'full') await refreshOpenChanges($)
    }

    // Toasts once per climb past a threshold (context, 5h/7d pace, projection).
    const checkAlerts = async () => {
      const [usage, nowMs, previous, isKnown, mark] = await Promise.all([
        $.session.usage(),
        $.clock.now(),
        read($, alerts),
        read($, hasWindows),
        read($, cache),
      ])
      // A main-thread response marks the cache: the sign one came back this session.
      const isSubscription = accountHasWindows(isKnown, usage.rateLimits.length, mark !== null)
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
        toastLevel(settings.toasts),
      )
      for (const text of toasts) $.ui.toast(text, { timeoutMs: 8000 })
      if (JSON.stringify(levels) !== JSON.stringify(previous)) await update($, alerts, () => levels)

      // Once per response, a large prefix toasts a few minutes before its cache lapses.
      const status = await readCache($, usage, nowMs)
      if (settings.cache !== 'off' && status && isExpiryDue(status) && (await read($, cache))?.isExpiryWarned === false) {
        await update($, cache, mark => (mark ? { ...mark, isExpiryWarned: true } : mark))
        $.ui.toast(cacheExpiryMessage(status.remainingMs, status.tokens, await read($, hasHandoff)), { timeoutMs: 60_000 })
      }
    }

    await refreshGit()
    await refreshCompactAt($)
    await refreshCacheConfig($)
    $.clock.every(60_000, () => void Promise.all([refreshCompactAt($), refreshCacheConfig($)]))
    $.clock.every(5000, () => void Promise.all([refreshGit(), checkAlerts()]).catch(() => {}))

    // The reset and cache countdowns move with the clock.
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

  // A prompt typed while idle over a cold cache of a large prefix is held: the person picks
  // sending it, compacting first or a new conversation; any but sending hands it back to the
  // box. A prompt typed mid-turn rides a warm cache. Images cannot go back to the box, and one
  // handed back unsent goes the second time (so a dialog that cannot open never traps it): those,
  // and prompts not typed by the person, go out with a toast of what they re-cache.
  // With the cache set to warn, every such prompt goes with the toast; set off, nothing is said.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId !== undefined || settings.cache === 'off') return next(e)
    let choice: string | undefined
    try {
      const status = await readCache($, await $.session.usage(), await $.clock.now())
      if (!status || status.remainingMs > 0 || status.tokens < CACHE_ALERT_TOKENS) return next(e)
      const isHandoff = await read($, hasHandoff)
      if (settings.cache === 'warn') {
        $.ui.toast(coldPromptMessage(status.tokens, isHandoff), { timeoutMs: 15_000 })
        return next(e)
      }
      const held = await read($, heldPrompt)
      if (held !== null) await update($, heldPrompt, () => null)
      if (e.origin.kind !== 'composer' || (e.attachments?.length ?? 0) > 0 || held === e.text) {
        $.ui.toast(coldPromptMessage(status.tokens, isHandoff), { timeoutMs: 15_000 })
        return next(e)
      }
      choice = await $.ui
        .ask(coldQuestion(status.tokens), { header: 'Cold cache', options: coldChoices(isHandoff) })
        .catch(() => undefined)
      if (choice === COLD_SEND) return next(e)
    } catch {
      // The prompt is sent whatever happened to the band.
      return next(e)
    }
    const commands = choice === undefined ? undefined : coldCommands(choice)
    if (commands === undefined) await update($, heldPrompt, () => e.text).catch(() => undefined)
    // A command run from inside the prompt's own hook is refused: they run once it returns.
    const text = e.text
    $.clock.after(0, () => void afterHold($, text, commands ?? []))
    return { drop: heldMessage(commands === undefined ? undefined : choice) }
  })

  // A compaction or a /clear leaves the next prompt a small prefix to cache: the old mark would
  // count it cold at its old size.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && 'messages' in result) {
      await update($, cache, () => null).catch(() => undefined)
    }
    return result
  })
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const result = await next(e)
    await update($, cache, () => null).catch(() => undefined)
    return result
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
    if (e.element === 'settings-button' && data?.action === 'band-settings') void openSettings($, settings)
    if (e.element === 'model-button' && data?.open === 'model') void openModelPicker($)
    if (e.element === 'context-label' && data?.open === 'context') void openContext($)
    if (e.element === 'folder-button' && data?.action === 'copy-path') void copyPath($, e.surface)
    if (e.element === 'folder-button' && data?.action === 'folder-menu') void openFolderMenu($)
    if (e.element === 'changes-button' && data?.action === 'git-changes') void openChanges($)
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const [model, cwd, usage, nowMs, gitInfo, effortLevel, isKnownSubscription, threshold, isCostShown, isResetAtShown, cacheMark] =
      await Promise.all([
      $.session.model(),
      $.session.cwd(),
      $.session.usage(),
      $.clock.now(),
      read($, git),
      read($, effort),
      read($, hasWindows),
      read($, compactAt),
      read($, showCost),
      read($, showResetAt),
      read($, cache),
    ])

    const cacheNow = await readCache($, usage, nowMs).catch(() => undefined)
    const lines = buildLines({
      model,
      effort: effortLevel,
      cwd,
      git: gitInfo,
      contextPercent: usage.context.percent,
      compactAtPercent: threshold === null ? undefined : (threshold / usage.context.window) * 100,
      costUsd: usage.cost?.usd,
      hasWindows: accountHasWindows(isKnownSubscription, usage.rateLimits.length, cacheMark !== null),
      fiveHour: rateLimit('five_hour', usage.rateLimits, nowMs),
      sevenDay: rateLimit('seven_day', usage.rateLimits, nowMs),
      showCost: isCostShown,
      showResetAt: isResetAtShown,
      cache: cacheNow,
      settings,
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
          if (press === 'settings' || press === 'usage' || press === 'reset' || press === 'cache' || press === 'changes') {
            const names = {
              settings: ['settings-button', 'band-settings'],
              usage: ['usage-button', 'toggle-cost'],
              reset: ['reset-button', 'toggle-reset'],
              cache: ['cache-button', 'cache-details'],
              changes: ['changes-button', 'git-changes'],
            } as const
            const [name, action] = names[press]
            const key = keyOf(name)
            return (
              <Client
                key={key}
                module="./swap-button.tsx"
                props={{ parts: toParts(group), altParts: toParts(group), trigger: 'none', action, isHoverInverse: true }}
              />
            )
          }
          // Only the folder's icon (its first two columns) shows the path and copies it. On the
          // desktop the longer path reflows the band under the pointer, which then leaves and
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
                ...(press === 'folder' && { hotColumns: 2, restAction: 'folder-menu' }),
              }}
            />
          )
        }
        if (press === 'settings') return <Button key="band-settings" plain label={label} onPress={() => void openSettings($, settings)} />
        if (press === 'model') return <Button key="open-model" plain label={label} onPress={() => void openModelPicker($)} />
        if (press === 'context-label') return <Button key="open-context" plain label={label} onPress={() => void openContext($)} />
        if (press === 'cache') return <Button key="cache-details" plain label={label} onPress={() => void showCacheDetails($)} />
        if (press === 'changes') return <Button key="git-changes" plain label={label} onPress={() => void openChanges($)} />
        // One element for the whole folder: its menu, which copies the path too.
        if (press === 'folder') return <Button key="folder-menu" plain label={label} onPress={() => void openFolderMenu($)} />
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


  on('ui.render', { component: 'Pane', requestId: MENU_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [cwd, tools] = await Promise.all([$.session.cwd(), read($, host)])
    const items = tools ? menuItems(tools) : []
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-middle">
          {cwd}
        </Text>
        {items.map((item, i) => (
          <Button key={item.action} hotkey={String(i + 1)} label={item.label} onPress={press => void runAction($, item, press.surface)} />
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const { Box, Button } = $.ui.resolve(e)
    const width = Math.max(...SETTING_ROWS.map(row => row.label.length)) + 2
    // The terminal lines the values up in a column; the desktop collapses the spaces, so a colon parts them.
    const label = (row: (typeof SETTING_ROWS)[number]) =>
      e.surface === 'terminal' ? `${row.label.padEnd(width)}${settings[row.key]}` : `${row.label}: ${settings[row.key]}`
    return (
      <Box flexDirection="column">
        {SETTING_ROWS.map((row, i) => (
          <Button
            key={row.key}
            hotkey={String(i + 1)}
            label={label(row)}
            onPress={() => void changeSetting($, row.key, nextValue(row.key, settings[row.key]))}
          />
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CHANGES_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const data = await read($, changes)
    if (data === null) return <Text dimColor>Reading the changes…</Text>
    const { files, untracked, isCut } = data
    if (files.length === 0 && untracked.length === 0) return <Text dimColor>No changes against HEAD.</Text>

    const added = files.reduce((sum, file) => sum + file.added, 0)
    const removed = files.reduce((sum, file) => sum + file.removed, 0)
    const hunks = (file: ChangedFile) => {
      if (file.isBinary) return <Text dimColor>binary file</Text>
      if (!file.hunks) return isCut && file.added + file.removed > 0 ? <Text dimColor>past what the pane shows</Text> : undefined
      if (!('Code' in elements)) return <Text>{file.hunks}</Text>
      const { Code } = elements
      return <Code source={file.hunks} format="diff" path={file.path} />
    }
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{`${files.length} file${files.length === 1 ? '' : 's'} changed`}</Text>
          <Text color={C.GR}>{` +${added}`}</Text>
          <Text color={C.RD}>{` −${removed}`}</Text>
          {untracked.length > 0 && <Text dimColor>{` · ${untracked.length} untracked`}</Text>}
        </Text>
        {files.map(file => (
          <Box key={`file:${file.path}`} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={STATUS_COLOR[file.status]} bold>
                {`${file.status} `}
              </Text>
              <Text bold>{file.path}</Text>
              <Text color={C.GR}>{` +${file.added}`}</Text>
              <Text color={C.RD}>{` −${file.removed}`}</Text>
            </Text>
            {hunks(file)}
          </Box>
        ))}
        {untracked.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Untracked</Text>
            {untracked.slice(0, UNTRACKED_SHOWN).map(path => (
              <Text color={C.OR}>{path}</Text>
            ))}
            {untracked.length > UNTRACKED_SHOWN && <Text dimColor>{`… ${untracked.length - UNTRACKED_SHOWN} more`}</Text>}
          </Box>
        )}
        {isCut && (
          <Box marginTop={1}>
            <Text dimColor>The diff is cut short here; git diff shows the rest.</Text>
          </Box>
        )}
      </Box>
    )
  })

}

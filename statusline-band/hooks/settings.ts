// The person's choices from /config (the manifest's userConfig): which of the band's parts show,
// and how the prompt cache and the thresholds speak up. The defaults are the band as it always was.

export type Settings = {
  /** `full`: branch, files changed (with their diff), ahead/behind, an operation under way and its
   *  conflicts; `branch`: the branch and an operation under way with its conflicts; `off`: the folder alone. */
  git: 'full' | 'branch' | 'off'
  /** `auto`: the 5h/7d rate limits on a subscription, the cost on an API account. */
  usage: 'auto' | 'rate-limits' | 'cost' | 'off'
  /** `ask`: the countdown, and a prompt over a cold cache held with a question; `warn`: the
   *  countdown and a toast; `off`: neither. */
  cache: 'ask' | 'warn' | 'off'
  /** The context and rate-limit thresholds and a long tool call ending: `critical` only the red ones. */
  toasts: 'all' | 'critical' | 'off'
  runningTool: boolean
}

export const DEFAULT_SETTINGS: Settings = { git: 'full', usage: 'auto', cache: 'ask', toasts: 'all', runningTool: true }

const CHOICES = {
  git: ['full', 'branch', 'off'],
  usage: ['auto', 'rate-limits', 'cost', 'off'],
  cache: ['ask', 'warn', 'off'],
  toasts: ['all', 'critical', 'off'],
} as const

function pick<K extends keyof typeof CHOICES>(options: Readonly<Record<string, unknown>>, key: K): Settings[K] {
  const value = options[key]
  return (CHOICES[key] as readonly unknown[]).includes(value) ? (value as Settings[K]) : DEFAULT_SETTINGS[key]
}

// The engine fills the defaults and drops a value outside a field's options; this keeps the band
// whole even so.
export function readSettings(options: Readonly<Record<string, unknown>> = {}): Settings {
  return {
    git: pick(options, 'git'),
    usage: pick(options, 'usage'),
    cache: pick(options, 'cache'),
    toasts: pick(options, 'toasts'),
    runningTool: typeof options.runningTool === 'boolean' ? options.runningTool : DEFAULT_SETTINGS.runningTool,
  }
}

// The lowest level of a threshold that toasts: 1 orange and red, 2 red alone.
export function toastLevel(toasts: Settings['toasts']): number {
  return toasts === 'all' ? 1 : toasts === 'critical' ? 2 : Infinity
}

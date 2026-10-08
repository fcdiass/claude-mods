/** The repository the session is in: its name, branch, files changed and commits ahead of/behind upstream. */
export type GitInfo = { repo: string; branch: string; changes: number; ahead: number; behind: number }

/** A tool call in flight. */
export type RunningTool = { id: string; label: string; startedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'statusline-band': {
      git: GitInfo | null
      /** Reasoning effort of the main thread's last model request, or from settings before one. */
      effort: string | null
      /** A subscription's account, whose 5h/7d windows stand in for the cost. */
      hasWindows: boolean
      running: RunningTool[]
      /** Last alert level raised per gauge, so each crossing toasts once. */
      alerts: Record<string, number>
      /** The token count at which auto-compaction runs; null when it is off or not yet read. */
      compactAt: number | null
      /** A click on the windows swapped them for the API-equivalent cost. */
      showCost: boolean
      /** A click on a reset countdown swapped both for the clock time of the reset. */
      showResetAt: boolean
    }
  }
}

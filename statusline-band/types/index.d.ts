export type GitInfo = { repo: string; branch: string }

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
    }
  }
}

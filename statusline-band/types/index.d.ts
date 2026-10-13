/**
 * The repository the session is in: its name, branch, files changed and commits ahead of/behind
 * upstream; an operation git left under way (`REBASING 2/5`, `MERGING`) and the files it left in
 * conflict, when there is one.
 */
export type GitInfo = {
  repo: string
  branch: string
  changes: number
  ahead: number
  behind: number
  conflicts?: number
  operation?: string
}

/** One file of the working tree's diff against HEAD: its hunks, cut to what the pane draws. */
export type ChangedFile = {
  path: string
  status: 'A' | 'D' | 'M' | 'R'
  added: number
  removed: number
  hunks: string
  isBinary: boolean
}

/** The working tree's changes, as the changes pane shows them. */
export type GitChanges = { files: ChangedFile[]; untracked: string[]; isCut: boolean }

/** What the folder's menu can run on this machine. */
export type HostTools = { platform: 'windows' | 'mac' | 'linux'; hasCode: boolean; hasWt: boolean }

/** The prompt cache's time to live, as Claude Code names it. */
export type CacheTtl = '5m' | '1h'

/** What the main thread's requests have told so far. */
export type CacheMark = {
  /** When the last response arrived, in `$.clock.now()`'s milliseconds. */
  at: number
  /** The prompt the last request sent: read from the cache, written to it, and uncached. */
  tokens: number
  /** The model that answered it. */
  model: string
  /** Over all requests: tokens read from the cache, and all the input tokens. */
  readTokens: number
  inputTokens: number
  /** Requests that wrote most of a large prefix again. */
  rebuilds: number
  /** The expiry toast for this mark has shown. */
  isExpiryWarned: boolean
}

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
      /** What the main thread's model requests told of the prompt cache; null before the first. */
      cache: CacheMark | null
      /** The cache TTL the settings or environment force; null when the account decides. */
      ttlOverride: CacheTtl | null
      /** ai-memory's handoff skill is installed, so the cache toasts suggest it. */
      hasHandoff: boolean
      /** A prompt held over a cold cache and handed back unsent: the same text sent again goes. */
      heldPrompt: string | null
      /** The changes pane's diff; null until it first opens. */
      changes: GitChanges | null
      /** The folder menu's programs, found the first time it opens. */
      host: HostTools | null
    }
  }
}

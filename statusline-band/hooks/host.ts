// The folder menu's actions as programs of the machine: its file manager, VS Code and a terminal
// opened in the folder. Each returns at once, so `$.process.run` never waits on the window.

import type { HostTools } from '../types'

export type FolderAction = 'files' | 'code' | 'terminal' | 'copy'
export type MenuItem = { action: FolderAction; label: string }

export function fileManager(platform: HostTools['platform']): string {
  return platform === 'windows' ? 'Explorer' : platform === 'mac' ? 'Finder' : 'file manager'
}

// The menu, in order; VS Code only where its command is found.
export function menuItems(host: HostTools): MenuItem[] {
  return [
    { action: 'files', label: `Open in ${fileManager(host.platform)}` },
    ...(host.hasCode ? [{ action: 'code' as const, label: 'Open in VS Code' }] : []),
    { action: 'terminal', label: 'Open a terminal here' },
    { action: 'copy', label: 'Copy path' },
  ]
}

// The program an action runs, and the folder it runs in; undefined for the copy, done in place.
export function actionArgv(action: FolderAction, host: HostTools, folder: string): { argv: string[]; cwd?: string } | undefined {
  // Explorer reads a path with forward slashes as none and opens Documents.
  const path = host.platform === 'windows' ? folder.replace(/\//g, '\\') : folder
  if (action === 'files') {
    return { argv: host.platform === 'windows' ? ['explorer.exe', path] : [host.platform === 'mac' ? 'open' : 'xdg-open', path] }
  }
  if (action === 'code') {
    // `code` is a .cmd on Windows, which only cmd starts.
    return { argv: host.platform === 'windows' ? ['cmd.exe', '/d', '/c', 'code', path] : ['code', path] }
  }
  if (action === 'terminal') {
    if (host.platform === 'windows') {
      return { argv: host.hasWt ? ['wt.exe', '-d', path] : ['cmd.exe', '/d', '/c', 'start', '', '/D', path, 'cmd.exe'] }
    }
    if (host.platform === 'mac') return { argv: ['open', '-a', 'Terminal', path] }
    // Detached, so the call returns while the terminal stays open.
    return { argv: ['sh', '-c', 'nohup x-terminal-emulator >/dev/null 2>&1 &'], cwd: path }
  }
  return undefined
}

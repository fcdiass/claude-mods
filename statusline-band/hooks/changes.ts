// Reading `git diff HEAD` into the files the changes pane shows: each one's status, the lines
// added and removed, and its hunks, whole hunks only (a hunk cut short draws as no diff).

import type { ChangedFile } from '../types'

// What the pane draws of the hunks, in all; past it the rest of the files list without them.
export const DIFF_LIMIT = 80_000

export function parseDiff(stdout: string, limit = DIFF_LIMIT): { files: ChangedFile[]; isCut: boolean } {
  const files: ChangedFile[] = []
  let used = 0
  let isCut = false
  const chunks = stdout.split(/^(?=diff --git )/m).filter(chunk => chunk.startsWith('diff --git '))
  for (const chunk of chunks) {
    const lines = chunk.replace(/\r\n/g, '\n').split('\n')
    const firstHunk = lines.findIndex(line => line.startsWith('@@'))
    const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk)
    const body = firstHunk === -1 ? [] : lines.slice(firstHunk)

    // The new path from `+++ b/…`, the old one from `--- a/…` for a deletion; else the header's.
    const after = header.find(line => line.startsWith('+++ b/'))?.slice('+++ b/'.length)
    const before = header.find(line => line.startsWith('--- a/'))?.slice('--- a/'.length)
    const renamed = header.find(line => line.startsWith('rename to '))?.slice('rename to '.length)
    const fromHeader = / b\/(.*)$/.exec(lines[0] ?? '')?.[1] ?? ''
    const path = after ?? renamed ?? before ?? fromHeader

    const status: ChangedFile['status'] = header.some(line => line.startsWith('new file mode'))
      ? 'A'
      : header.some(line => line.startsWith('deleted file mode'))
        ? 'D'
        : renamed !== undefined
          ? 'R'
          : 'M'
    const isBinary = header.some(line => line.startsWith('Binary files '))

    let added = 0
    let removed = 0
    for (const line of body) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }

    // Whole hunks while they fit what is left; once one does not, none after it.
    const hunks: string[] = []
    for (const hunk of body.join('\n').split(/^(?=@@)/m)) {
      if (!hunk.startsWith('@@')) continue
      if (isCut || used + hunk.length > limit) {
        isCut = true
        break
      }
      hunks.push(hunk)
      used += hunk.length
    }
    files.push({ path, status, added, removed, hunks: hunks.join('').replace(/\n+$/, ''), isBinary })
  }
  return { files, isCut }
}

// Reading `git status --porcelain=v2 --branch --show-stash`: the branch, the files changed, the
// commits ahead of and behind its upstream, and the stashes kept.

export type GitStatus = { branch: string; changes: number; ahead: number; behind: number; stashes: number; conflicts: number }

export function parseGitStatus(stdout: string): GitStatus {
  let head = ''
  let oid = ''
  let ahead = 0
  let behind = 0
  let stashes = 0
  let changes = 0
  let conflicts = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length)
    else if (line.startsWith('# branch.ab ')) {
      const ab = /\+(\d+) -(\d+)/.exec(line)
      ahead = Number(ab?.[1] ?? 0)
      behind = Number(ab?.[2] ?? 0)
    } else if (line.startsWith('# stash ')) {
      // Only when there is one: `# stash 2`.
      stashes = Number(line.slice('# stash '.length)) || 0
    } else if (!line.startsWith('#')) {
      changes += 1
      // `u`: a file a merge, rebase or cherry-pick left in conflict.
      if (line.startsWith('u ')) conflicts += 1
    }
  }
  // A detached HEAD reads as its short sha, as `rev-parse --short` gives it.
  const branch = head === '(detached)' ? `#${oid.slice(0, 7)}` : head
  return { branch, changes, ahead, behind, stashes, conflicts }
}

export type GitOperation = { operation: string; branch?: string }
export type GitDirReader = { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string> }

/**
 * An operation git left under way, named as git's own prompt names it, from the files it keeps
 * in the git folder; a rebase also says the branch it rebases, since HEAD is detached meanwhile.
 */
export async function readOperation(gitDir: string, dir: GitDirReader): Promise<GitOperation | null> {
  const at = (name: string) => `${gitDir}/${name}`
  const text = (name: string) => dir.read(at(name)).then(t => t.trim(), () => '')
  const rebases = [
    ['rebase-merge', 'msgnum', 'end'],
    ['rebase-apply', 'next', 'last'],
  ] as const
  for (const [folder, step, total] of rebases) {
    if (!(await dir.exists(at(folder)))) continue
    const isAm = folder === 'rebase-apply' && (await dir.exists(at(`${folder}/applying`)))
    const [n, m, head] = await Promise.all([text(`${folder}/${step}`), text(`${folder}/${total}`), text(`${folder}/head-name`)])
    const progress = n && m ? ` ${n}/${m}` : ''
    const branch = head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : undefined
    return { operation: `${isAm ? 'AM' : 'REBASING'}${progress}`, ...(branch && { branch }) }
  }
  const marks = [
    ['MERGE_HEAD', 'MERGING'],
    ['CHERRY_PICK_HEAD', 'CHERRY-PICKING'],
    ['REVERT_HEAD', 'REVERTING'],
    ['BISECT_LOG', 'BISECTING'],
  ] as const
  for (const [file, operation] of marks) if (await dir.exists(at(file))) return { operation }
  return null
}

// Reading `git status --porcelain=v2 --branch`: the branch, the files changed, and the commits
// ahead of and behind its upstream.

export type GitStatus = { branch: string; changes: number; ahead: number; behind: number }

export function parseGitStatus(stdout: string): GitStatus {
  let head = ''
  let oid = ''
  let ahead = 0
  let behind = 0
  let changes = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length)
    else if (line.startsWith('# branch.ab ')) {
      const ab = /\+(\d+) -(\d+)/.exec(line)
      ahead = Number(ab?.[1] ?? 0)
      behind = Number(ab?.[2] ?? 0)
    } else if (!line.startsWith('#')) changes += 1
  }
  // A detached HEAD reads as its short sha, as `rev-parse --short` gives it.
  const branch = head === '(detached)' ? `#${oid.slice(0, 7)}` : head
  return { branch, changes, ahead, behind }
}

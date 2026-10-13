import { expect, test } from 'claude-code/testing'

import { parseGitStatus, readOperation } from './git'

test('a branch with changes and an upstream ahead and behind', async () => {
  const stdout = [
    '# branch.oid 267267a42b23ebeb960dec01545e1d6850120bb5',
    '# branch.head develop',
    '# branch.upstream origin/develop',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 2a5a751 2a5a751 hooks/format.ts',
    '1 D. N... 100644 000000 000000 3ea4361 0000000 hooks/old.tsx',
    '? hooks/git.ts',
    '',
  ].join('\r\n')
  expect(parseGitStatus(stdout)).toEqual({ branch: 'develop', changes: 3, ahead: 2, behind: 1, stashes: 0, conflicts: 0 })
})

test('a clean branch with no upstream', async () => {
  const stdout = '# branch.oid 267267a42b23ebeb960dec01545e1d6850120bb5\n# branch.head main\n'
  expect(parseGitStatus(stdout)).toEqual({ branch: 'main', changes: 0, ahead: 0, behind: 0, stashes: 0, conflicts: 0 })
})

test('the stashes kept, which git lists only when there are some', async () => {
  const stdout = '# branch.oid 267267a42b23ebeb960dec01545e1d6850120bb5\n# branch.head main\n# stash 2\n'
  expect(parseGitStatus(stdout)).toMatchObject({ stashes: 2, changes: 0 })
})

test('a detached HEAD reads as its short sha', async () => {
  const stdout = '# branch.oid 267267a42b23ebeb960dec01545e1d6850120bb5\n# branch.head (detached)\n'
  expect(parseGitStatus(stdout).branch).toBe('#267267a')
})

test('files a rebase left in conflict count apart', async () => {
  const stdout = [
    '# branch.oid 267267a42b23ebeb960dec01545e1d6850120bb5',
    '# branch.head (detached)',
    'u UU N... 100644 100644 100644 100644 2a5a751 2a5a751 2a5a751 hooks/format.ts',
    '1 M. N... 100644 100644 100644 2a5a751 2a5a751 hooks/git.ts',
  ].join('\n')
  expect(parseGitStatus(stdout)).toMatchObject({ changes: 2, conflicts: 1 })
})

test('an operation under way reads as git names it', async () => {
  const folder = (files: Record<string, string>) => ({
    exists: async (path: string) => Object.keys(files).some(f => f === path || f.startsWith(`${path}/`)),
    read: async (path: string) => {
      const text = files[path]
      if (text === undefined) throw new Error('missing')
      return text
    },
  })
  const G = 'D:/repo/.git'
  expect(await readOperation(G, folder({}))).toBeNull()
  expect(
    await readOperation(G, folder({ [`${G}/rebase-merge/msgnum`]: '2\n', [`${G}/rebase-merge/end`]: '5\n', [`${G}/rebase-merge/head-name`]: 'refs/heads/feature\n' })),
  ).toEqual({ operation: 'REBASING 2/5', branch: 'feature' })
  expect(await readOperation(G, folder({ [`${G}/rebase-apply/next`]: '1', [`${G}/rebase-apply/last`]: '3', [`${G}/rebase-apply/applying`]: '' }))).toEqual({
    operation: 'AM 1/3',
  })
  expect(await readOperation(G, folder({ [`${G}/MERGE_HEAD`]: 'abc' }))).toEqual({ operation: 'MERGING' })
  expect(await readOperation(G, folder({ [`${G}/CHERRY_PICK_HEAD`]: 'abc' }))).toEqual({ operation: 'CHERRY-PICKING' })
})

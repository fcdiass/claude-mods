import { expect, test } from 'claude-code/testing'

import { parseGitStatus } from './git'

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
  expect(parseGitStatus(stdout)).toEqual({ branch: 'develop', changes: 3, ahead: 2, behind: 1 })
})

test('a clean branch with no upstream', async () => {
  const stdout = '# branch.oid 267267a42b23ebeb960dec01545e1d6850120bb5\n# branch.head main\n'
  expect(parseGitStatus(stdout)).toEqual({ branch: 'main', changes: 0, ahead: 0, behind: 0 })
})

test('a detached HEAD reads as its short sha', async () => {
  const stdout = '# branch.oid 267267a42b23ebeb960dec01545e1d6850120bb5\n# branch.head (detached)\n'
  expect(parseGitStatus(stdout).branch).toBe('#267267a')
})

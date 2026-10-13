import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseDiff } from './changes'
import { buildLines } from './format'
import { actionArgv, menuItems } from './host'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const CWD = 'D:\\repos\\claude-mods'
const GIT_DIR = 'D:/repos/claude-mods/.git'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const
const pane = (requestId: string) =>
  ({
    component: 'Pane',
    requestId,
    props: { title: requestId, isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as const

const DIFF = [
  'diff --git a/hooks/format.ts b/hooks/format.ts',
  'index 2a5a751..3b6b862 100644',
  '--- a/hooks/format.ts',
  '+++ b/hooks/format.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' const d = 5',
  '@@ -20,2 +21,2 @@ function f() {',
  '-  return a',
  '+  return b',
  '   // end',
  'diff --git a/docs/new file.md b/docs/new file.md',
  'new file mode 100644',
  'index 0000000..e69de29',
  '--- /dev/null',
  '+++ b/docs/new file.md',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index e69de29..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/logo.png b/logo.png',
  'index 1111111..2222222 100644',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git a/a.ts b/b.ts',
  'similarity index 100%',
  'rename from a.ts',
  'rename to b.ts',
  '',
].join('\n')

test('the diff reads as files, each with its status, its counts and its hunks', async () => {
  const { files, isCut } = parseDiff(DIFF)
  expect(isCut).toBe(false)
  expect(files.map(f => [f.status, f.path, f.added, f.removed, f.isBinary])).toEqual([
    ['M', 'hooks/format.ts', 3, 2, false],
    ['A', 'docs/new file.md', 1, 0, false],
    ['D', 'old.txt', 0, 1, false],
    ['M', 'logo.png', 0, 0, true],
    ['R', 'b.ts', 0, 0, false],
  ])
  expect(files[0]?.hunks.startsWith('@@ -1,3 +1,4 @@\n const a = 1')).toBe(true)
  expect(files[0]?.hunks.endsWith('   // end')).toBe(true)
})

test('a diff past the limit keeps whole hunks and says it was cut', async () => {
  const { files, isCut } = parseDiff(DIFF, 90)
  expect(isCut).toBe(true)
  // The first hunk fits, the second would not: never half a hunk.
  expect(files[0]?.hunks).toBe('@@ -1,3 +1,4 @@\n const a = 1\n-const b = 2\n+const b = 3\n+const c = 4\n const d = 5')
  expect(files[0]?.added).toBe(3)
})

test('the folder menu runs each platform own programs', async () => {
  const windows = { platform: 'windows', hasCode: true, hasWt: true } as const
  expect(menuItems(windows).map(i => i.label)).toEqual(['Open in Explorer', 'Open in VS Code', 'Open a terminal here', 'Copy path'])
  expect(menuItems({ platform: 'mac', hasCode: false, hasWt: false }).map(i => i.label)).toEqual([
    'Open in Finder',
    'Open a terminal here',
    'Copy path',
  ])
  expect(actionArgv('files', windows, 'D:/repos/x')).toEqual({ argv: ['explorer.exe', 'D:\\repos\\x'] })
  expect(actionArgv('code', windows, 'D:\\repos\\x')).toEqual({ argv: ['cmd.exe', '/d', '/c', 'code', 'D:\\repos\\x'] })
  expect(actionArgv('terminal', windows, 'D:\\repos\\x')).toEqual({ argv: ['wt.exe', '-d', 'D:\\repos\\x'] })
  expect(actionArgv('terminal', { ...windows, hasWt: false }, 'D:\\x')?.argv).toEqual(['cmd.exe', '/d', '/c', 'start', '', '/D', 'D:\\x', 'cmd.exe'])
  expect(actionArgv('files', { platform: 'linux', hasCode: false, hasWt: false }, '/home/me')).toEqual({ argv: ['xdg-open', '/home/me'] })
  expect(actionArgv('terminal', { platform: 'mac', hasCode: false, hasWt: false }, '/Users/me')).toEqual({
    argv: ['open', '-a', 'Terminal', '/Users/me'],
  })
  expect(actionArgv('copy', windows, 'D:\\x')).toBeUndefined()
})

// A Windows machine with VS Code and Windows Terminal, in a repository mid-rebase.
function engine(on: On) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const ran: string[][] = []
  const opened: string[] = []
  const closed: string[] = []
  const copied: string[] = []
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 10_000, window: 1_000_000, percent: 1 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('env.get', ($, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } }) as never
    if (argv[0] === 'where.exe') return out('C:\\found.exe')
    const args = argv.slice(argv.indexOf('-C') + 2)
    if (args[0] === 'rev-parse') return out(`D:/repos/claude-mods\n${GIT_DIR}\n`)
    if (args[0] === 'status') {
      return out(
        [
          '# branch.oid 267267a42b23ebeb960dec01545e1d6850120bb5',
          '# branch.head (detached)',
          'u UU N... 100644 100644 100644 100644 2a5a751 2a5a751 2a5a751 hooks/format.ts',
          '1 .M N... 100644 100644 100644 2a5a751 2a5a751 hooks/git.ts',
        ].join('\n'),
      )
    }
    if (args[0] === 'diff') return out(DIFF)
    if (args[0] === 'ls-files') return out('notes.txt\n')
    return out('', argv[0] === 'explorer.exe' ? 1 : 0)
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } } as never
  })
  on('ui.toast', () => ({ value: undefined }))
  return { ran, opened, closed, copied }
}

const click = async (band: { pointer: (e: never) => Promise<void> }, key: string, x: number) => {
  await band.pointer({ type: 'down', x, y: 0, button: 'left', in: key } as never)
  await band.pointer({ type: 'up', x, y: 0, button: 'left', in: key } as never)
}

test('a rebase under way shows in red beside the branch it rebases, with its conflicts', async () => {
  const [line1] = buildLines({
    model: 'claude-opus-5-5',
    cwd: CWD,
    git: { repo: 'claude-mods', branch: 'feature', changes: 2, ahead: 0, behind: 0, conflicts: 1, operation: 'REBASING 2/5' },
    hasWindows: false,
    nowMs: NOW,
  })
  expect(line1.map(seg => seg.text).join('')).toContain('⎇  claude-mods:feature REBASING 2/5 ✖1 ●2')
  expect(line1.find(seg => seg.text === ' REBASING 2/5')).toMatchObject({ color: 'red', bold: true })
  expect(line1.find(seg => seg.text === '●2')?.press).toBe('changes')
})

test('a click on the files changed opens their diff in a pane', async ($, on) => {
  const { opened } = engine(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  await click(band as never, 'changes-button', 0)
  expect(opened).toEqual(['git-changes'])

  const changes = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...pane('git-changes') })
  const drawn = JSON.stringify(await changes.drawn())
  expect(drawn).toContain('5 files changed')
  expect(drawn).toContain('hooks/format.ts')
  expect(drawn).toContain('@@ -1,3 +1,4 @@')
  expect(drawn).toContain('binary file')
  expect(drawn).toContain('notes.txt')
})

test('a click on the folder name opens its menu; a choice runs and closes it', async ($, on) => {
  const { ran, opened, closed, copied } = engine(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...BAND })
  await click(band as never, 'folder-button', 5)
  expect(opened).toEqual(['folder-menu'])
  expect(copied).toEqual([])

  const menu = await $.ui.mount({ plugin: 'statusline-band', surface: 'terminal', ...pane('folder-menu') })
  const drawn = JSON.stringify(await menu.drawn())
  for (const label of ['Open in Explorer', 'Open in VS Code', 'Open a terminal here', 'Copy path']) expect(drawn).toContain(label)

  await menu.press({ key: 'files' })
  expect(ran.at(-1)).toEqual(['explorer.exe', CWD])
  await menu.press({ key: 'terminal' })
  expect(ran.at(-1)).toEqual(['wt.exe', '-d', CWD])
  await menu.press({ key: 'copy' })
  expect(copied).toEqual([CWD])
  expect(closed).toEqual(['folder-menu', 'folder-menu', 'folder-menu'])
})

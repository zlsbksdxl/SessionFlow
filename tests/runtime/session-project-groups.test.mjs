import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-session-project-groups-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const modulePath = path.join(tempRoot, 'session-project-groups.mjs')
fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync('src/lib/session-project-groups.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
}).outputText)
const { groupChatsByProject, isChatInProject } = await import(pathToFileURL(modulePath).href)

function at(day) {
  return `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`
}

function chat(sessionId, cwd, day, extra = {}) {
  return { sessionId, cwd, updatedAt: at(day), ...extra }
}

function project(projectId, label, cwd, day = 1) {
  return { projectId, label, cwd, createdAt: at(1), updatedAt: at(day) }
}

test('explicit project IDs assign chats independently of execution and original workspace paths', () => {
  const projects = { repo: project('repo', 'Repository', '/work/repo') }
  const local = chat('local', '/work/repo', 20, { chatProjectId: 'repo' })
  const worktree = chat('worktree', '/work/.orrery-worktrees/repo/1234', 24, {
    chatProjectId: 'repo',
    project: { repoRoot: '/other/original', cwd: '/other/original', name: 'Old name' },
  })
  const groups = groupChatsByProject([local, worktree], projects)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'repo')
  assert.equal(groups[0].cwd, '/work/repo')
  assert.equal(groups[0].label, 'Repository')
  assert.equal(groups[0].hasDuplicateName, false)
  assert.deepEqual(groups[0].chats, [local, worktree])
  assert.equal(groups[0].chats[1], worktree)
  assert.equal(isChatInProject(local, projects), true)
})

test('old matching cwd metadata and missing project IDs stay in Recents without creating fallback groups', () => {
  const projects = { repo: project('repo', 'Repository', '/work/repo') }
  const chats = [
    chat('old', '/work/repo', 20, { project: { cwd: '/work/repo', repoRoot: '/work/repo', name: 'Repository' } }),
    chat('unknown', '/work/repo', 21, { chatProjectId: 'deleted-project' }),
    chat('empty', '', 22, { chatProjectId: '' }),
    chat('inherited-name', '/work/repo', 23, { chatProjectId: 'toString' }),
  ]
  const groups = groupChatsByProject(chats, projects)

  assert.ok(chats.every((entry) => !isChatInProject(entry, projects)))
  assert.deepEqual(chats.filter((entry) => !isChatInProject(entry, projects)), chats)
  assert.deepEqual(groups.map((group) => [group.key, group.chats]), [['repo', []]])
  assert.deepEqual(groupChatsByProject(chats, {}), [])
})

test('ordinary and group chats preserve caller priority while project order uses their latest activity', () => {
  const projects = {
    alpha: project('alpha', 'Alpha', '/work/alpha'),
    beta: project('beta', 'Beta', '/work/beta'),
  }
  const pinnedOldChat = chat('pinned-old', '/work/alpha', 20, { chatProjectId: 'alpha' })
  const groupChat = chat('group-chat', '/work/alpha', 25, { chatProjectId: 'alpha', members: [{ name: 'Planner' }] })
  const betaChat = chat('beta-chat', '/work/beta', 24, { chatProjectId: 'beta' })
  const unrelated = chat('unrelated', '/work/alpha', 26)
  const groups = groupChatsByProject([pinnedOldChat, betaChat, groupChat, unrelated], projects)

  assert.deepEqual(groups.map((group) => group.key), ['alpha', 'beta'])
  assert.deepEqual(groups[0].chats.map((entry) => entry.sessionId), ['pinned-old', 'group-chat'])
  assert.equal(groups[0].chats[1], groupChat)
  assert.equal(groups[1].chats[0], betaChat)
})

test('registered empty projects remain visible and use their own update time and stored display metadata', () => {
  const projects = {
    active: project('active', 'Active', '/work/active', 10),
    empty: project('empty', 'Empty project', '/work/empty/', 26),
    root: project('root', 'Root project', '/', 24),
  }
  const groups = groupChatsByProject([chat('active-chat', '/work/active', 25, { chatProjectId: 'active' })], projects)

  assert.deepEqual(groups.map((group) => group.key), ['empty', 'active', 'root'])
  assert.deepEqual(groups[0].chats, [])
  assert.equal(groups[0].cwd, '/work/empty/')
  assert.equal(groups[0].label, 'Empty project')
  assert.equal(groups[2].cwd, '/')
  assert.equal(groupChatsByProject([], projects).length, 3)
  assert.deepEqual(groupChatsByProject([], {}), [])
})

test('same labels and same or case-differing paths remain separate projects keyed by project ID', () => {
  const projects = {
    first: project('first', 'Shared', '/work/Repo'),
    samePath: project('samePath', 'Shared', '/work/Repo'),
    otherPath: project('otherPath', 'Shared', '/other/Repo'),
    lowerCase: project('lowerCase', 'Shared', '/work/repo'),
    unique: project('unique', 'Unique', '/work/Unique'),
  }
  const groups = groupChatsByProject([
    chat('first-chat', '/work/Repo', 20, { chatProjectId: 'first' }),
    chat('same-path-chat', '/work/Repo', 21, { chatProjectId: 'samePath' }),
  ], projects)

  assert.equal(groups.length, 5)
  assert.deepEqual(new Set(groups.map((group) => group.key)), new Set(Object.keys(projects)))
  assert.ok(groups.filter((group) => group.label === 'Shared').every((group) => group.hasDuplicateName))
  assert.equal(groups.find((group) => group.key === 'unique').hasDuplicateName, false)
  assert.deepEqual(groups.find((group) => group.key === 'first').chats.map((entry) => entry.sessionId), ['first-chat'])
  assert.deepEqual(groups.find((group) => group.key === 'samePath').chats.map((entry) => entry.sessionId), ['same-path-chat'])
})

test('grouping preserves frozen inputs, caller order, original chat objects and supplied archived entries', () => {
  const archived = Object.freeze(chat('archived', '/work/repo', 20, { archived: true, chatProjectId: 'repo' }))
  const active = Object.freeze(chat('active', '/work/repo', 24, { chatProjectId: 'repo' }))
  const chats = Object.freeze([archived, active])
  const projects = Object.freeze({ repo: Object.freeze(project('repo', 'Repository', '/work/repo')) })
  const before = structuredClone({ chats, projects })
  const groups = groupChatsByProject(chats, projects)

  assert.deepEqual({ chats, projects }, before)
  assert.notEqual(groups[0].chats, chats)
  assert.deepEqual(groups[0].chats.map((entry) => entry.sessionId), ['archived', 'active'])
  assert.equal(groups[0].chats[0], archived)
  assert.equal(groups[0].chats[1], active)
  assert.equal(groups[0].chats[0].archived, true)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-chat-project-drag-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const modulePath = path.join(tempRoot, 'chat-project-drag.mjs')
fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync('src/lib/chat-project-drag.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
}).outputText)
const { chatProjectDragMime, encodeChatProjectDrag, decodeChatProjectDrag, canMoveSidebarChat, isChatProjectDropAllowed } = await import(pathToFileURL(modulePath).href)

const ssh = { kind: 'ssh', host: 'server-a', runtimePath: '/opt/sessionflow' }
function session(sessionId, extra = {}) {
  return { sessionId, cwd: '/work/source', status: 'idle', project: { cwd: '/work/source', workMode: 'local' }, ...extra }
}
function project(projectId, cwd, extra = {}) { return { projectId, cwd, label: projectId, ...extra } }
function state() {
  return {
    sessions: { one: session('one', { chatProjectId: 'source' }), two: session('two') },
    chatProjects: { source: project('source', '/work/source'), target: project('target', '/work/target'), same: project('same', '/work/source'), remote: project('remote', '/work/remote', { connection: ssh }) },
    collaborationSessions: {}, clusters: {}, subscriptions: {}, pendingActivations: {}, planCouncils: {}, workflowPlans: {}, dynamicSpawnGroups: {}, runQueue: [],
  }
}
function group(current) {
  current.collaborationSessions.group = { sessionId: 'group', cwd: '/work/source', chatProjectId: 'source', members: [{ sessionId: 'one' }, { sessionId: 'two' }], triggers: {}, discussions: {} }
  return current
}

test('internal chat drags round-trip a bounded versioned payload and reject foreign or malformed content', () => {
  assert.equal(chatProjectDragMime, 'application/x-orrery-chat')
  assert.deepEqual(JSON.parse(encodeChatProjectDrag('  one  ')), { version: 1, sessionId: 'one' })
  assert.deepEqual(decodeChatProjectDrag(encodeChatProjectDrag('会话-id')), { sessionId: '会话-id' })
  assert.deepEqual(decodeChatProjectDrag(encodeChatProjectDrag('x'.repeat(512))), { sessionId: 'x'.repeat(512) })
  for (const input of ['', 'https://external.example/chat', 'one', 'null', '[]', '1', '{', '{}', JSON.stringify({ version: 2, sessionId: 'one' }),
    JSON.stringify({ sessionId: 'one' }), JSON.stringify({ version: 1, sessionId: [] }), JSON.stringify({ version: 1, sessionId: '  ' }),
    JSON.stringify({ version: 1, sessionId: 'x'.repeat(513) }), JSON.stringify({ version: 1, sessionId: 'one\nother' }),
    JSON.stringify({ version: 1, sessionId: 'one', targetProjectId: 'target' }), ' '.repeat(4097), null, undefined]) {
    assert.equal(decodeChatProjectDrag(input), undefined)
  }
  for (const input of ['', '  ', 'x'.repeat(513), 'one\u0000other', null]) assert.throws(() => encodeChatProjectDrag(input), /valid chat/)
})

test('only idle or failed ordinary chats with no pending run or active goal can be dragged', () => {
  const current = state()
  assert.equal(canMoveSidebarChat(current, 'one'), true)
  current.sessions.one.status = 'failed'; current.sessions.one.archived = true
  assert.equal(canMoveSidebarChat(current, 'one'), true)
  for (const status of ['running', 'pending', 'killed']) {
    current.sessions.one.status = status
    assert.equal(canMoveSidebarChat(current, 'one'), false)
  }
  current.sessions.one.status = 'idle'; current.runQueue.push({ sessionId: 'one' })
  assert.equal(canMoveSidebarChat(current, 'one'), false)
  current.runQueue = []; current.sessions.one.threadGoal = { status: 'active' }
  assert.equal(canMoveSidebarChat(current, 'one'), false)
  current.sessions.one.threadGoal.status = 'paused'
  assert.equal(canMoveSidebarChat(current, 'one'), true)
  assert.equal(canMoveSidebarChat(current, 'missing'), false)
  assert.equal(canMoveSidebarChat(current, 'constructor'), false)
  assert.equal(canMoveSidebarChat(current, '__proto__'), false)
})

test('project and Recents targets use explicit membership, reject no-ops, and treat dangling membership as Recents', () => {
  const current = state()
  assert.equal(isChatProjectDropAllowed(current, 'one', 'target'), true)
  assert.equal(isChatProjectDropAllowed(current, 'one', null), true)
  assert.equal(isChatProjectDropAllowed(current, 'one', 'source'), false)
  assert.equal(isChatProjectDropAllowed(current, 'one', 'missing'), false)
  assert.equal(isChatProjectDropAllowed(current, 'one', 'constructor'), false)
  assert.equal(isChatProjectDropAllowed(current, 'two', null), false)
  assert.equal(isChatProjectDropAllowed(current, 'two', 'source'), true, 'cwd does not imply project membership')
  current.sessions.one.chatProjectId = 'removed-project'
  assert.equal(isChatProjectDropAllowed(current, 'one', null), false)
  assert.equal(isChatProjectDropAllowed(current, 'one', 'target'), true)
  assert.equal(isChatProjectDropAllowed(current, 'unknown', 'target'), false)
})

test('group chats move as complete idle groups, never as standalone private members or into SSH projects', () => {
  const current = group(state())
  assert.equal(canMoveSidebarChat(current, 'group'), true)
  assert.equal(canMoveSidebarChat(current, 'one'), false)
  assert.equal(canMoveSidebarChat(current, 'two'), false)
  assert.equal(isChatProjectDropAllowed(current, 'group', 'target'), true)
  assert.equal(isChatProjectDropAllowed(current, 'group', null), true)
  assert.equal(isChatProjectDropAllowed(current, 'group', 'remote'), false)
  current.sessions.two.status = 'running'
  assert.equal(canMoveSidebarChat(current, 'group'), false)
  current.sessions.two.status = 'idle'; delete current.sessions.two
  assert.equal(canMoveSidebarChat(current, 'group'), false)
})

test('pending group activity blocks dragging, while active or paused discussions allow affiliation changes without changing directory', () => {
  for (const status of ['pending', 'running']) {
    const current = group(state()); current.collaborationSessions.group.triggers.work = { status }
    assert.equal(canMoveSidebarChat(current, 'group'), false)
  }
  for (const status of ['active', 'paused']) {
    const current = group(state()); current.collaborationSessions.group.discussions.topic = { status }
    assert.equal(canMoveSidebarChat(current, 'group'), true)
    assert.equal(isChatProjectDropAllowed(current, 'group', 'target'), false)
    assert.equal(isChatProjectDropAllowed(current, 'group', 'same'), true)
    assert.equal(isChatProjectDropAllowed(current, 'group', null), true)
    assert.equal(isChatProjectDropAllowed(current, 'group', 'remote'), false)
  }
  const current = group(state()); current.collaborationSessions.group.discussions.topic = { status: 'completed' }
  assert.equal(canMoveSidebarChat(current, 'group'), true)
  current.collaborationSessions.other = { sessionId: 'other', members: [{ sessionId: 'one' }], triggers: {}, discussions: {} }
  assert.equal(canMoveSidebarChat(current, 'group'), false)
})

test('managed worktrees can change affiliation in the same directory or return to Recents, but cannot switch directories', () => {
  const current = state()
  current.sessions.one.cwd = '/work/worktree'
  current.sessions.one.project.workMode = 'worktree'
  current.chatProjects.same.cwd = '/work/worktree/'
  assert.equal(canMoveSidebarChat(current, 'one'), true)
  assert.equal(isChatProjectDropAllowed(current, 'one', 'target'), false)
  assert.equal(isChatProjectDropAllowed(current, 'one', 'same'), true)
  assert.equal(isChatProjectDropAllowed(current, 'one', null), true)
})

test('known live workflow guards block directory changes while allowing pure same-directory affiliation changes', () => {
  const guards = [
    (current) => { current.clusters.team = { nodeIds: ['one'] } },
    (current) => { current.clusters.team = { nodeIds: [], masterSessionId: 'one' } },
    (current) => { current.subscriptions.edge = { state: 'active', source: { kind: 'session', sessionId: 'one' }, target: { sessionId: 'two' } } },
    (current) => { current.subscriptions.edge = { state: 'active', source: { kind: 'session', sessionId: 'two' }, target: { sessionId: 'one' } } },
    (current) => { current.pendingActivations.turn = { target: 'one' } },
    (current) => { current.planCouncils.council = { phase: 'blocked', participants: { one: {} } } },
    (current) => { current.workflowPlans.plan = { 1: { status: 'active', executionMapping: { participantSessionIds: { coder: 'one' } } } } },
    (current) => { current.dynamicSpawnGroups.spawn = { status: 'creating', parentSessionId: 'one', children: [] } },
  ]
  for (const guard of guards) {
    const current = state(); guard(current)
    assert.equal(isChatProjectDropAllowed(current, 'one', 'target'), false)
    assert.equal(isChatProjectDropAllowed(current, 'one', 'same'), true)
    assert.equal(isChatProjectDropAllowed(current, 'one', null), true)
  }
})

test('SSH host changes are workspace changes even for the same path string, while ordinary ungoverned chats may move to SSH', () => {
  const current = state()
  assert.equal(isChatProjectDropAllowed(current, 'one', 'remote'), true)
  current.sessions.one.workspaceConnection = ssh
  current.sessions.one.project.workMode = 'worktree'
  current.chatProjects.same.connection = { ...ssh }
  current.chatProjects.remote = project('remote', '/work/source', { connection: { ...ssh, host: 'server-b' } })
  assert.equal(isChatProjectDropAllowed(current, 'one', 'same'), true)
  assert.equal(isChatProjectDropAllowed(current, 'one', 'remote'), false)
  assert.equal(isChatProjectDropAllowed(current, 'one', 'source'), false)
  current.sessions.one.cwd = '/work/path\\literal'
  current.chatProjects.same.cwd = '/work/path/literal'
  assert.equal(isChatProjectDropAllowed(current, 'one', 'same'), false, 'backslashes in POSIX paths are filename characters, not separators')
})

test('preflight remains pure and a valid foreign payload cannot authorize an unknown source chat', () => {
  const current = state(); current.sessions.one.status = 'failed'
  const before = structuredClone(current)
  Object.freeze(current.sessions.one)
  Object.freeze(current.chatProjects.target)
  assert.equal(isChatProjectDropAllowed(current, 'one', 'target'), true)
  assert.deepEqual(current, before)
  const payload = decodeChatProjectDrag(JSON.stringify({ version: 1, sessionId: 'not-an-existing-chat' }))
  assert.deepEqual(payload, { sessionId: 'not-an-existing-chat' })
  assert.equal(isChatProjectDropAllowed(current, payload.sessionId, 'target'), false)
})

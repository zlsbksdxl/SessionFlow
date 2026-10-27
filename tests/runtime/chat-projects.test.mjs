import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { moveChatToProject } from '../../dist-electron/electron/runtime/sessions/chatProjectRuntime.js'
import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

const ts = '2026-10-26T00:00:00.000Z'
const human = { actor: { kind: 'human' } }

function chat(sessionId, cwd, extra = {}) {
  return {
    sessionId, nodeId: sessionId, providerKind: 'codex', providerInstanceId: 'default-codex', agent: 'codex',
    backend: 'codex-app-server', providerSessionId: `native-${sessionId}`, backendSessionId: `native-${sessionId}`,
    label: sessionId, prompt: 'Original prompt', cwd, role: 'worker', status: 'idle', createdAt: ts, updatedAt: ts,
    project: { name: path.basename(cwd), cwd, workMode: 'local' },
    messages: [{ id: `message-${sessionId}`, sessionId, role: 'user', content: 'Remember original history', ts, status: 'complete' }],
    runtimeSettings: { runtimeMode: 'auto' }, ...extra,
  }
}

function group(cwd) {
  return {
    sessionType: 'collaboration', sessionId: 'group', title: 'Group', cwd, createdAt: ts, updatedAt: ts, archived: false,
    members: ['one', 'two'].map((sessionId) => ({ memberId: `member-${sessionId}`, label: sessionId, sessionId, lastReadSeq: 0, readCursors: {} })),
    events: [], discussions: {}, triggers: {}, councilIds: [],
  }
}

function fixture(t, customize = () => {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-chat-projects-')))
  const from = path.join(root, 'original'); const to = path.join(root, 'target')
  fs.mkdirSync(from); fs.mkdirSync(to)
  const state = createEmptyGraphState()
  state.sessions.one = chat('one', from)
  customize(state, { root, from, to })
  const storageFile = path.join(root, 'state.json')
  fs.writeFileSync(storageFile, JSON.stringify(state))
  const adapter = new DeterministicProviderAdapter({ kind: 'codex' })
  const options = { storageFile, providerAdapters: new Map([['codex', adapter]]) }
  const runtime = new RuntimeSessionManager(options)
  const runtimes = [runtime]
  t.after(async () => {
    for (const manager of [...runtimes].reverse()) await manager.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const command = (kind, input, actor = human.actor) => runtime.dispatchCommand({ kind, input, actor })
  return { root, from, to, state, storageFile, options, runtime, runtimes, adapter, command }
}

async function settled(runtime, sessionId) {
  for (let i = 0; i < 200; i++) {
    if (runtime.getState().sessions[sessionId].status === 'idle') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Deterministic provider did not settle')
}

test('projects register explicitly, canonical paths deduplicate, and existing cwd metadata never auto-assigns chats', async (t) => {
  const f = fixture(t)
  assert.deepEqual(f.runtime.getState().chatProjects, {})
  assert.equal(f.runtime.getState().sessions.one.chatProjectId, undefined)
  const first = await f.command('upsert_chat_project', { cwd: f.from, label: 'Original project' })
  const alias = path.join(f.root, 'directory-alias')
  fs.symlinkSync(f.from, alias)
  const second = await f.command('upsert_chat_project', { cwd: alias + '/', label: 'Renamed project' })
  assert.equal(second.projectId, first.projectId)
  assert.equal(Object.keys(second.state.chatProjects).length, 1)
  assert.equal(second.state.chatProjects[first.projectId].cwd, f.from)
  assert.equal(second.state.chatProjects[first.projectId].label, 'Renamed project')
  assert.equal(second.state.sessions.one.chatProjectId, undefined)
  assert.equal(f.adapter.startedTurns.length, 0)
  const before = f.runtime.getState().chatProjects
  for (const input of [{ cwd: 'relative' }, { cwd: path.join(f.root, 'missing') }, { cwd: f.to, label: '' }]) {
    await assert.rejects(f.command('upsert_chat_project', input))
    assert.deepEqual(f.runtime.getState().chatProjects, before)
  }
  await assert.rejects(f.command('upsert_chat_project', { cwd: f.to }, { kind: 'runtime' }), /human/)
})

test('new chats enter a project only with explicit membership and a same-directory fork inherits it', async (t) => {
  const f = fixture(t)
  const { projectId } = await f.command('upsert_chat_project', { cwd: f.to, label: 'New chat project' })
  const created = await f.command('create_session', { prompt: 'Project conversation', providerKind: 'codex', chatProjectId: projectId })
  await settled(f.runtime, created.sessionId)
  const session = f.runtime.getState().sessions[created.sessionId]
  assert.equal(session.chatProjectId, projectId)
  assert.equal(session.cwd, f.to)
  assert.equal(f.adapter.startedTurns[0].cwd, f.to)
  const assistant = session.messages.findLast((message) => message.role === 'assistant')
  const fork = await f.command('fork_session', { sessionId: session.sessionId, messageId: assistant.id })
  assert.equal(fork.state.sessions[fork.sessionId].chatProjectId, projectId)
  assert.equal(fork.state.sessions[fork.sessionId].cwd, f.to)
  const unassigned = await f.command('create_session', { prompt: 'Standalone conversation', cwd: f.to, providerKind: 'codex' })
  await settled(f.runtime, unassigned.sessionId)
  assert.equal(f.runtime.getState().sessions[unassigned.sessionId].chatProjectId, undefined, 'matching cwd never silently assigns new chats')
})

test('unknown or mismatched create-time project selection rejects before sessions and provider side effects', async (t) => {
  const f = fixture(t)
  const { projectId } = await f.command('upsert_chat_project', { cwd: f.to })
  const before = f.runtime.getState()
  for (const input of [{ chatProjectId: 'missing', cwd: f.to }, { chatProjectId: projectId, cwd: f.from }, { chatProjectId: null, cwd: f.to }]) {
    await assert.rejects(f.command('create_session', { prompt: 'Must not create', providerKind: 'codex', context: 'Must not deliver', ...input }), /project/i)
    assert.deepEqual(f.runtime.getState().sessions, before.sessions)
    assert.deepEqual(f.runtime.getState().nodes, before.nodes)
    assert.equal(f.adapter.startedTurns.length, 0)
  }
})

test('a linked chat inherits assigned source worktree membership only for that exact source directory', async (t) => {
  const f = fixture(t, (state, { root, from }) => {
    const worktree = path.join(root, 'existing-worktree'); fs.mkdirSync(worktree)
    state.chatProjects.known = { projectId: 'known', label: 'Original project', cwd: from, createdAt: ts, updatedAt: ts }
    state.sessions.one = chat('one', worktree, {
      chatProjectId: 'known', project: { name: 'Original project', cwd: from, repoRoot: from, workMode: 'worktree', branch: 'existing-worktree' },
    })
    state.sessions.two = chat('two', worktree)
  })
  const source = f.runtime.getState().sessions.one
  const created = await f.command('create_session', {
    prompt: 'Continue alongside this source', providerKind: 'codex', sourceSessionId: 'one', chatProjectId: 'known', cwd: source.cwd, workMode: 'local',
  })
  await settled(f.runtime, created.sessionId)
  const state = f.runtime.getState()
  assert.equal(state.sessions[created.sessionId].cwd, source.cwd)
  assert.equal(state.sessions[created.sessionId].chatProjectId, 'known')
  assert.equal(state.sessions[created.sessionId].project.workMode, 'local', 'a linked conversation does not own the source worktree')
  assert.deepEqual(state.sessions.one.project, source.project)
  const count = Object.keys(state.sessions).length
  for (const input of [{ sourceSessionId: 'two', cwd: source.cwd }, { sourceSessionId: 'one', cwd: f.to }]) {
    await assert.rejects(f.command('create_session', {
      prompt: 'Invalid inheritance', providerKind: 'codex', chatProjectId: 'known', ...input,
    }), /match the selected project/)
    assert.equal(Object.keys(f.runtime.getState().sessions).length, count)
  }
  assert.equal(f.adapter.startedTurns.length, 1)
})

test('moving preserves history and native identity, and the next provider turn uses the selected directory', async (t) => {
  const f = fixture(t)
  const { projectId } = await f.command('upsert_chat_project', { cwd: f.to })
  const original = f.runtime.getState().sessions.one
  const moved = await f.command('move_chat_to_project', { sessionId: 'one', projectId })
  const current = moved.state.sessions.one
  assert.equal(current.cwd, f.to)
  assert.equal(current.project.cwd, f.to)
  assert.equal(current.chatProjectId, projectId)
  assert.equal(current.providerSessionId, original.providerSessionId)
  assert.equal(current.backendSessionId, original.backendSessionId)
  assert.equal(current.nodeId, original.nodeId)
  assert.deepEqual(current.messages, original.messages)
  assert.equal(f.adapter.startedTurns.length, 0, 'moving does not run the provider')
  await f.runtime.resumeSession({ sessionId: 'one', message: 'Continue from the new project' })
  await settled(f.runtime, 'one')
  assert.equal(f.adapter.startedTurns[0].cwd, f.to)
  assert.equal(f.adapter.startedTurns[0].backendSessionId, original.providerSessionId)
  const removed = await f.command('move_chat_to_project', { sessionId: 'one', projectId: null })
  assert.equal(removed.state.sessions.one.chatProjectId, undefined)
  assert.equal(removed.state.sessions.one.cwd, f.to, 'returning to Recents does not silently change execution cwd')
})

test('membership and empty registered projects survive restart without auto-assigning matching unassigned chats', async (t) => {
  const f = fixture(t, (state, { from }) => { state.sessions.two = chat('two', from) })
  const { projectId } = await f.command('upsert_chat_project', { cwd: f.to, label: 'Persistent project' })
  const empty = await f.command('upsert_chat_project', { cwd: f.from, label: 'Empty project' })
  await f.command('move_chat_to_project', { sessionId: 'one', projectId })
  await f.runtime.killAll()
  const restored = new RuntimeSessionManager(f.options); f.runtimes.splice(0, 1, restored)
  const state = restored.getState()
  assert.equal(state.chatProjects[projectId].label, 'Persistent project')
  assert.equal(state.chatProjects[empty.projectId].label, 'Empty project')
  assert.equal(state.sessions.one.chatProjectId, projectId)
  assert.equal(state.sessions.one.cwd, f.to)
  assert.equal(state.sessions.two.chatProjectId, undefined)
})

test('a group moves all members atomically and retains group and private histories', async (t) => {
  const f = fixture(t, (state, { from }) => {
    state.sessions.two = chat('two', from)
    state.collaborationSessions.group = group(from)
  })
  const { projectId } = await f.command('upsert_chat_project', { cwd: f.to })
  const before = f.runtime.getState()
  const result = await f.command('move_chat_to_project', { sessionId: 'group', projectId })
  assert.equal(result.state.collaborationSessions.group.cwd, f.to)
  assert.equal(result.state.collaborationSessions.group.chatProjectId, projectId)
  for (const id of ['one', 'two']) {
    assert.equal(result.state.sessions[id].cwd, f.to)
    assert.equal(result.state.sessions[id].chatProjectId, projectId)
    assert.deepEqual(result.state.sessions[id].messages, before.sessions[id].messages)
    assert.equal(result.state.sessions[id].providerSessionId, before.sessions[id].providerSessionId)
  }
  assert.deepEqual(result.state.collaborationSessions.group.events, before.collaborationSessions.group.events)
  assert.equal(f.adapter.startedTurns.length, 0)
  const removed = await f.command('move_chat_to_project', { sessionId: 'group', projectId: null })
  assert.equal(removed.state.collaborationSessions.group.chatProjectId, undefined)
  assert.ok(['one', 'two'].every((id) => removed.state.sessions[id].chatProjectId === undefined && removed.state.sessions[id].cwd === f.to))
})

test('rejected moves preserve fields and history, including a busy group member after an idle member', async (t) => {
  const f = fixture(t, (state, { from }) => {
    state.sessions.two = chat('two', from)
    state.collaborationSessions.group = group(from)
  })
  const { projectId } = await f.command('upsert_chat_project', { cwd: f.to })
  const before = f.runtime.getState().sessions.one
  await assert.rejects(f.command('move_chat_to_project', { sessionId: 'one', projectId: 'missing' }), /existing project/)
  await assert.rejects(f.command('move_chat_to_project', { sessionId: 'one', projectId }, { kind: 'runtime' }), /human/)
  await assert.rejects(f.command('move_chat_to_project', { sessionId: 'one', projectId }), /whole group/)
  assert.deepEqual(f.runtime.getState().sessions.one, before)
  await f.runtime.resumeSession({ sessionId: 'two', message: 'ORRERY_SLEEP' })
  await assert.rejects(f.command('move_chat_to_project', { sessionId: 'group', projectId }), /finish/)
  assert.deepEqual(f.runtime.getState().sessions.one, before)
  assert.equal(f.runtime.getState().collaborationSessions.group.cwd, f.from)
})

test('worktrees, queued turns, active goals, clusters, and live relationships cannot switch directory', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-project-guards-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const to = path.join(root, 'to'); fs.mkdirSync(to)
  const cases = [
    (state) => { state.sessions.one.status = 'pending' },
    (state) => { state.runQueue = [{ sessionId: 'one' }] },
    (state) => { state.sessions.one.threadGoal = { status: 'active' } },
    (state) => { state.sessions.one.project.workMode = 'worktree' },
    (state) => { state.clusters = { team: { nodeIds: ['one'] } } },
    (state) => { state.subscriptions = { relation: { state: 'active', source: { sessionId: 'one' }, target: { sessionId: 'other' } } } },
    (state) => { state.pendingActivations = { activation: { target: 'one' } } },
    (state) => { state.planCouncils = { council: { phase: 'ready-for-cross-review', participants: { one: {} } } } },
    (state) => { state.workflowPlans = { workflow: { 1: { status: 'active', executionMapping: { participantSessionIds: { coder: 'one' } } } } } },
    (state) => { state.dynamicSpawnGroups = { generation: { status: 'active', children: [{ sessionId: 'one' }] } } },
  ]
  for (const customize of cases) {
    const state = createEmptyGraphState()
    state.sessions.one = chat('one', root)
    state.chatProjects.target = { projectId: 'target', label: 'Target', cwd: to, createdAt: ts, updatedAt: ts }
    customize(state)
    const before = structuredClone(state)
    const host = { state: () => state, runs: () => new Map(), getState: () => state, appendKernelEvent() {}, touch() {}, broadcast() {} }
    assert.throws(() => moveChatToProject(host, { sessionId: 'one', projectId: 'target' }, human))
    assert.deepEqual(state, before)
  }
})

test('same-directory project assignment preserves worktree metadata and existing workflow configuration', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-project-same-cwd-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const state = createEmptyGraphState()
  state.sessions.one = chat('one', root, { project: { name: 'Worktree', cwd: '/original/project', repoRoot: '/original/project', workMode: 'worktree' } })
  state.chatProjects.target = { projectId: 'target', label: 'Same directory', cwd: root, createdAt: ts, updatedAt: ts }
  state.clusters.team = { nodeIds: ['one'] }
  const projectMetadata = structuredClone(state.sessions.one.project)
  const host = { state: () => state, runs: () => new Map(), getState: () => state, appendKernelEvent() {}, touch() {}, broadcast() {} }
  moveChatToProject(host, { sessionId: 'one', projectId: 'target' }, human)
  assert.equal(state.sessions.one.chatProjectId, 'target')
  assert.deepEqual(state.sessions.one.project, projectMetadata)
  assert.deepEqual(state.clusters.team.nodeIds, ['one'])
  moveChatToProject(host, { sessionId: 'one', projectId: null }, human)
  assert.equal(state.sessions.one.chatProjectId, undefined)
  assert.equal(state.sessions.one.cwd, root)
})

test('invalid saved memberships fall back to Recents while valid missing-directory projects remain recoverable', async (t) => {
  const f = fixture(t, (state, { root, from }) => {
    state.chatProjects.valid = { projectId: 'valid', label: 'Saved', cwd: path.join(root, 'deleted-project'), createdAt: ts, updatedAt: ts }
    state.chatProjects.invalid = { projectId: 'wrong', label: 'Broken', cwd: 'relative', createdAt: ts, updatedAt: ts }
    state.sessions.one.chatProjectId = 'valid'
    state.sessions.two = chat('two', from, { chatProjectId: 'missing' })
    state.sessions.three = chat('three', from, { chatProjectId: 3 })
  })
  const state = f.runtime.getState()
  assert.equal(state.sessions.one.chatProjectId, 'valid')
  assert.equal(state.sessions.two.chatProjectId, undefined)
  assert.equal(state.sessions.three.chatProjectId, undefined)
  assert.equal(state.chatProjects.invalid, undefined)
  assert.equal(state.chatProjects.valid.label, 'Saved')
  await assert.rejects(f.command('move_chat_to_project', { sessionId: 'two', projectId: 'valid' }))
  assert.equal(f.runtime.getState().sessions.two.chatProjectId, undefined)
})

test('legacy workspace chats, worktrees, and native imports recover one shared project without changing execution or history', async (t) => {
  const f = fixture(t, (state, { root, from }) => {
    delete state.chatProjectMembershipVersion
    const worktree = path.join(root, 'legacy-worktree'); fs.mkdirSync(worktree)
    state.sessions.two = chat('two', worktree, { project: { name: 'Original project', cwd: from, repoRoot: from, workMode: 'worktree' } })
    state.sessions.imported = chat('imported', from + '/', {
      project: undefined,
      nativeSessionOrigin: { sourceKey: 'legacy-source', nativeSessionId: 'native-imported', providerKind: 'codex', providerInstanceId: 'default-codex', importedAt: ts },
    })
  })
  const state = f.runtime.getState()
  const projects = Object.values(state.chatProjects)
  assert.equal(state.chatProjectMembershipVersion, 1)
  assert.equal(projects.length, 1)
  assert.equal(projects[0].cwd, f.from)
  for (const id of ['one', 'two', 'imported']) {
    assert.equal(state.sessions[id].chatProjectId, projects[0].projectId)
    assert.equal(state.sessions[id].providerSessionId, f.state.sessions[id].providerSessionId)
    assert.equal(state.sessions[id].messages[0].content, f.state.sessions[id].messages[0].content)
  }
  assert.equal(state.sessions.two.cwd, f.state.sessions.two.cwd)
  assert.equal(state.sessions.two.project.workMode, 'worktree')
  assert.equal(state.sessions.imported.nativeSessionOrigin.nativeSessionId, 'native-imported')
  assert.equal(f.adapter.startedTurns.length, 0)
})

test('legacy migration reuses known directories and preserves valid explicit memberships while invalid references stay in Recents', (t) => {
  const f = fixture(t, (state, { from, to }) => {
    delete state.chatProjectMembershipVersion
    state.chatProjects.known = { projectId: 'known', label: 'Keep this label', cwd: from + '/', createdAt: ts, updatedAt: ts }
    state.chatProjects.other = { projectId: 'other', label: 'Explicit destination', cwd: to, createdAt: ts, updatedAt: ts }
    state.sessions.two = chat('two', from, { chatProjectId: 'missing' })
    state.sessions.three = chat('three', from, { chatProjectId: 'other' })
    state.sessions.noPath = chat('noPath', '', { project: undefined })
  })
  const state = f.runtime.getState()
  assert.equal(state.sessions.one.chatProjectId, 'known')
  assert.equal(state.chatProjects.known.label, 'Keep this label')
  assert.equal(Object.keys(state.chatProjects).length, 2)
  assert.equal(state.sessions.two.chatProjectId, undefined)
  assert.equal(state.sessions.three.chatProjectId, 'other')
  assert.equal(state.sessions.noPath.chatProjectId, undefined, 'normalization defaults must not invent a legacy project')
})

test('legacy group chats coordinate unassigned member memberships using their original project', (t) => {
  const f = fixture(t, (state, { root, from }) => {
    delete state.chatProjectMembershipVersion
    const worktree = path.join(root, 'group-worktree'); fs.mkdirSync(worktree)
    for (const id of ['one', 'two']) state.sessions[id] = chat(id, worktree, {
      project: { name: 'Original group project', cwd: from, repoRoot: from, workMode: 'worktree' },
    })
    state.collaborationSessions.group = group(worktree)
  })
  const state = f.runtime.getState()
  const projectId = state.collaborationSessions.group.chatProjectId
  assert.ok(projectId)
  assert.equal(state.chatProjects[projectId].cwd, f.from)
  assert.equal(state.sessions.one.chatProjectId, projectId)
  assert.equal(state.sessions.two.chatProjectId, projectId)
  assert.equal(state.collaborationSessions.group.cwd, f.state.collaborationSessions.group.cwd)
  assert.equal(state.sessions.one.cwd, f.state.sessions.one.cwd)
})

test('legacy migration is durable and does not reassign explicit Recents moves or later standalone chats', async (t) => {
  const f = fixture(t, (state) => { delete state.chatProjectMembershipVersion })
  const original = f.runtime.getState()
  const projectId = original.sessions.one.chatProjectId
  assert.ok(projectId)
  await f.runtime.killAll()
  const restored = new RuntimeSessionManager(f.options); f.runtimes.splice(0, 1, restored)
  assert.equal(restored.getState().chatProjectMembershipVersion, 1)
  assert.deepEqual(restored.getState().chatProjects, original.chatProjects)
  assert.equal(restored.getState().sessions.one.chatProjectId, projectId)
  await restored.dispatchCommand({ kind: 'move_chat_to_project', ...human, input: { sessionId: 'one', projectId: null } })
  const standalone = await restored.createSession({ prompt: 'Standalone after migration', cwd: f.from, providerKind: 'codex' })
  await settled(restored, standalone.sessionId)
  await restored.killAll()
  const again = new RuntimeSessionManager(f.options); f.runtimes.splice(0, 1, again)
  assert.equal(again.getState().sessions.one.chatProjectId, undefined)
  assert.equal(again.getState().sessions[standalone.sessionId].chatProjectId, undefined)
  assert.equal(again.getState().sessions.one.cwd, f.from)
  assert.equal(Object.keys(again.getState().chatProjects).length, 1)
})

test('legacy missing-directory history remains grouped without requiring its old folder or starting a provider', (t) => {
  const f = fixture(t, (state, { root }) => {
    delete state.chatProjectMembershipVersion
    state.sessions.imported = chat('imported', path.join(root, 'deleted-history-project'), { project: undefined, archived: true })
  })
  const state = f.runtime.getState()
  const session = state.sessions.imported
  assert.ok(session.chatProjectId)
  assert.equal(state.chatProjects[session.chatProjectId].cwd, f.state.sessions.imported.cwd)
  assert.equal(session.cwd, f.state.sessions.imported.cwd)
  assert.equal(session.archived, true)
  assert.equal(session.providerSessionId, 'native-imported')
  assert.equal(session.messages[0].content, 'Remember original history')
  assert.equal(f.adapter.startedTurns.length, 0)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js'
import { chatNameMaxLength } from '../../dist-electron/shared/chat-name.js'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

const ts = '2026-10-26T00:00:00.000Z'
const human = { actor: { kind: 'human' } }

function chat(sessionId, cwd) {
  return {
    sessionId, nodeId: sessionId, providerKind: 'codex', providerInstanceId: 'default-codex', agent: 'codex',
    backend: 'codex-app-server', providerSessionId: `native-${sessionId}`, backendSessionId: `native-${sessionId}`,
    label: sessionId, prompt: 'Original prompt', cwd, role: 'worker', status: 'idle', createdAt: ts, updatedAt: ts,
    project: { name: path.basename(cwd), cwd, workMode: 'local' }, chatProjectId: 'project',
    messages: [{ id: `message-${sessionId}`, sessionId, role: 'user', content: 'Original conversation text', ts, status: 'complete' }],
    runtimeSettings: { runtimeMode: 'auto' },
  }
}

function fixture(t, customize = () => {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-chat-rename-')))
  const state = createEmptyGraphState()
  state.chatProjects.project = { projectId: 'project', label: 'Project', cwd: root, createdAt: ts, updatedAt: ts }
  for (const id of ['one', 'two']) {
    state.sessions[id] = chat(id, root)
    state.nodes.push({ nodeId: id, sessionId: id, label: id, agent: 'codex', role: 'worker', status: 'idle', position: { x: 0, y: 0 } })
  }
  state.collaborationSessions.group = {
    sessionType: 'collaboration', sessionId: 'group', title: 'Original group', cwd: root, chatProjectId: 'project', createdAt: ts, updatedAt: ts, archived: false,
    members: ['one', 'two'].map((id) => ({ memberId: `member-${id}`, label: id, sessionId: id, lastReadSeq: 0, readCursors: {} })),
    events: [], discussions: {}, triggers: {}, councilIds: [],
  }
  customize(state)
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
  const rename = (input, actor = human.actor) => runtime.dispatchCommand({ kind: 'rename_chat', input, actor })
  return { root, runtime, runtimes, adapter, options, rename }
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function criticalSessionHash(session) {
  const fields = ['sessionId', 'nodeId', 'messages', 'prompt', 'cwd', 'project', 'chatProjectId', 'backend', 'backendSessionId',
    'providerKind', 'providerInstanceId', 'providerSessionId', 'providerResumeCursor', 'nativeSessionOrigin', 'status', 'runtimeSettings', 'role', 'archived', 'threadGoal']
  return hash(Object.fromEntries(fields.map((field) => [field, session[field]])))
}

test('a trimmed Chinese custom title updates the chat and graph node without touching execution, identity, history, or project membership', async (t) => {
  const f = fixture(t)
  const before = f.runtime.getState()
  const critical = criticalSessionHash(before.sessions.one)
  const result = await f.rename({ sessionId: 'one', label: '  三维占据模型讨论  \n' })
  assert.equal(result.ok, true)
  assert.equal(result.state.sessions.one.label, '三维占据模型讨论')
  assert.equal(result.state.sessions.one.labelIsCustom, true)
  assert.equal(result.state.nodes.find((node) => node.sessionId === 'one').label, '三维占据模型讨论')
  assert.equal(criticalSessionHash(result.state.sessions.one), critical)
  assert.equal(hash(result.state.sessions.two), hash(before.sessions.two))
  assert.deepEqual(result.state.collaborationSessions, before.collaborationSessions)
  assert.equal(f.adapter.startedTurns.length, 0)
})

test('group chat renaming updates only its title and timestamp, preserving member names and shared history', async (t) => {
  const f = fixture(t)
  const before = f.runtime.getState()
  const result = await f.rename({ sessionId: 'group', label: '  研究小组  ' })
  assert.equal(result.state.collaborationSessions.group.title, '研究小组')
  const stripTitle = (workspace) => { const copy = structuredClone(workspace); delete copy.title; delete copy.updatedAt; return copy }
  assert.equal(hash(stripTitle(result.state.collaborationSessions.group)), hash(stripTitle(before.collaborationSessions.group)))
  assert.equal(hash(result.state.sessions), hash(before.sessions))
  assert.equal(hash(result.state.nodes), hash(before.nodes))
  assert.equal(f.adapter.startedTurns.length, 0)
})

test('invalid names, missing chats, and non-human actors reject atomically without provider work', async (t) => {
  const f = fixture(t)
  const before = f.runtime.getState()
  for (const label of ['', ' \n\t ', 42, null, {}, [], 'x'.repeat(chatNameMaxLength + 1)]) {
    await assert.rejects(f.rename({ sessionId: 'one', label }), /chat name/i)
    assert.deepEqual(f.runtime.getState().sessions, before.sessions)
    assert.deepEqual(f.runtime.getState().nodes, before.nodes)
    assert.deepEqual(f.runtime.getState().collaborationSessions, before.collaborationSessions)
  }
  for (const sessionId of ['', 'missing', null]) {
    await assert.rejects(f.rename({ sessionId, label: 'Valid title' }), /chat/i)
  }
  for (const actor of [{ kind: 'runtime' }, { kind: 'agent', ref: 'one' }, { kind: 'master', ref: 'one' }]) {
    await assert.rejects(f.rename({ sessionId: 'one', label: 'Must not apply' }, actor), /human/i)
  }
  assert.equal(f.adapter.startedTurns.length, 0)
  assert.deepEqual(f.runtime.getState().sessions, before.sessions)
})

test('running chats can be renamed without interrupting or starting an additional provider turn', async (t) => {
  const f = fixture(t)
  await f.runtime.resumeSession({ sessionId: 'one', message: 'ORRERY_SLEEP' })
  const before = f.runtime.getState().sessions.one
  assert.equal(before.status, 'running')
  assert.equal(f.adapter.startedTurns.length, 1)
  const result = await f.rename({ sessionId: 'one', label: 'Running conversation' })
  assert.equal(result.state.sessions.one.status, 'running')
  assert.equal(result.state.sessions.one.label, 'Running conversation')
  assert.equal(criticalSessionHash(result.state.sessions.one), criticalSessionHash(before))
  assert.equal(f.adapter.startedTurns.length, 1)
})

test('custom default-looking labels and group titles survive restart with graph labels synchronized', async (t) => {
  const f = fixture(t)
  await f.rename({ sessionId: 'one', label: 'New Chat' })
  await f.rename({ sessionId: 'two', label: 'Codex 1' })
  await f.rename({ sessionId: 'group', label: '重命名的群聊' })
  const before = f.runtime.getState()
  await f.runtime.killAll()
  const restored = new RuntimeSessionManager(f.options); f.runtimes.splice(0, 1, restored)
  const state = restored.getState()
  for (const id of ['one', 'two']) {
    assert.equal(state.sessions[id].label, before.sessions[id].label)
    assert.equal(state.sessions[id].labelIsCustom, true)
    assert.equal(state.nodes.find((node) => node.sessionId === id).label, before.sessions[id].label)
    assert.equal(criticalSessionHash(state.sessions[id]), criticalSessionHash(before.sessions[id]))
  }
  assert.equal(state.collaborationSessions.group.title, '重命名的群聊')
  assert.equal(f.adapter.startedTurns.length, 0)
})

test('recovery accepts only a boolean custom-label marker and the shared title limit accepts its exact boundary', async (t) => {
  const f = fixture(t, (state) => {
    state.sessions.one.labelIsCustom = 'true'
    state.sessions.two.labelIsCustom = true
  })
  assert.equal(f.runtime.getState().sessions.one.labelIsCustom, false)
  assert.equal(f.runtime.getState().sessions.two.labelIsCustom, true)
  const result = await f.rename({ sessionId: 'one', label: '字'.repeat(chatNameMaxLength) })
  assert.equal(result.state.sessions.one.label.length, chatNameMaxLength)
  assert.equal(result.state.sessions.one.labelIsCustom, true)
})

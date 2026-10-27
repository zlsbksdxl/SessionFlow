import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

const ts = '2026-10-27T00:00:00.000Z'
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-project-menu-')))
  const target = path.join(root, 'target'); fs.mkdirSync(target)
  const state = createEmptyGraphState()
  state.chatProjects.project = { projectId: 'project', label: 'Project', cwd: root, createdAt: ts, updatedAt: ts }
  for (const id of ['one', 'two', 'three']) state.sessions[id] = {
    sessionId: id, nodeId: id, providerKind: 'codex', providerInstanceId: 'default-codex', agent: 'codex', backend: 'codex-app-server',
    providerSessionId: `native-${id}`, backendSessionId: `native-${id}`, label: id, prompt: 'History', cwd: root, chatProjectId: 'project',
    project: { name: 'Project', cwd: root, workMode: 'local' }, role: 'worker', status: 'idle', createdAt: ts, updatedAt: ts,
    messages: [{ id: `message-${id}`, sessionId: id, role: 'user', content: 'Keep this history', ts, status: 'complete' }], runtimeSettings: { runtimeMode: 'auto' },
  }
  state.collaborationSessions.group = {
    sessionType: 'collaboration', sessionId: 'group', title: 'Group', cwd: root, chatProjectId: 'project', createdAt: ts, updatedAt: ts, archived: false,
    members: ['one', 'two'].map((id) => ({ memberId: id, sessionId: id, label: id, lastReadSeq: 0, readCursors: {} })),
    events: [], discussions: {}, triggers: {}, councilIds: [],
  }
  const storageFile = path.join(root, 'state.json'); fs.writeFileSync(storageFile, JSON.stringify(state))
  const adapter = new DeterministicProviderAdapter({ kind: 'codex' })
  const options = { storageFile, providerAdapters: new Map([['codex', adapter]]) }
  const runtime = new RuntimeSessionManager(options); const runtimes = [runtime]
  t.after(async () => { for (const manager of runtimes) await manager.killAll(); fs.rmSync(root, { recursive: true, force: true }) })
  const command = (kind, input, actor = { kind: 'human' }) => runtime.dispatchCommand({ kind, input, actor })
  return { root, target, runtime, runtimes, options, command, adapter }
}

test('project pin, edit, and custom section metadata persist, and re-upsert does not erase metadata', async (t) => {
  const f = fixture(t)
  const { sectionId } = await f.command('upsert_chat_project_section', { label: '  Research  ' })
  await f.command('update_chat_project', { projectId: 'project', pinned: true, sectionId, label: '  实验项目  ' })
  await f.command('upsert_chat_project', { cwd: f.root })
  await f.runtime.killAll()
  const restored = new RuntimeSessionManager(f.options); f.runtimes.splice(0, 1, restored)
  assert.equal(restored.getState().chatProjects.project.label, '实验项目')
  assert.equal(restored.getState().chatProjects.project.pinned, true)
  assert.equal(restored.getState().chatProjects.project.sectionId, sectionId)
  assert.equal(restored.getState().chatProjectSections[sectionId].label, 'Research')
  assert.equal(f.adapter.startedTurns.length, 0)
})

test('directory edits move all project chats and group members atomically without rewriting history or native IDs', async (t) => {
  const f = fixture(t)
  const before = f.runtime.getState()
  const result = await f.command('update_chat_project', { projectId: 'project', cwd: f.target })
  assert.equal(result.state.chatProjects.project.cwd, f.target)
  assert.equal(result.state.collaborationSessions.group.cwd, f.target)
  for (const id of ['one', 'two', 'three']) {
    assert.equal(result.state.sessions[id].cwd, f.target)
    assert.equal(result.state.sessions[id].providerSessionId, before.sessions[id].providerSessionId)
    assert.deepEqual(result.state.sessions[id].messages, before.sessions[id].messages)
  }
  assert.equal(f.adapter.startedTurns.length, 0)
})

test('a busy project member rejects directory changes and archive-all without partial success', async (t) => {
  const f = fixture(t)
  await f.runtime.resumeSession({ sessionId: 'two', message: 'ORRERY_SLEEP' })
  const before = f.runtime.getState()
  await assert.rejects(f.command('update_chat_project', { projectId: 'project', cwd: f.target, label: 'Must not apply' }), /finish/i)
  await assert.rejects(f.command('archive_chat_project_chats', { projectId: 'project' }), /finish/i)
  const after = f.runtime.getState()
  assert.deepEqual(after.chatProjects, before.chatProjects)
  assert.equal(after.sessions.one.cwd, before.sessions.one.cwd)
  assert.equal(after.collaborationSessions.group.cwd, before.collaborationSessions.group.cwd)
  assert.equal(after.collaborationSessions.group.archived, false)
  assert.ok(Object.values(after.sessions).every((session) => !session.archived))
})

test('archive-all preserves the project and conversation records, and removing a project returns chats to Recents without changing cwd', async (t) => {
  const f = fixture(t)
  const before = f.runtime.getState()
  const archived = await f.command('archive_chat_project_chats', { projectId: 'project' })
  assert.ok(Object.values(archived.state.sessions).every((session) => session.archived))
  assert.equal(archived.state.collaborationSessions.group.archived, true)
  assert.ok(archived.state.chatProjects.project)
  const removed = await f.command('remove_chat_project', { projectId: 'project' })
  assert.equal(removed.state.chatProjects.project, undefined)
  assert.equal(removed.state.collaborationSessions.group.chatProjectId, undefined)
  for (const id of ['one', 'two', 'three']) {
    assert.equal(removed.state.sessions[id].chatProjectId, undefined)
    assert.equal(removed.state.sessions[id].cwd, before.sessions[id].cwd)
    assert.deepEqual(removed.state.sessions[id].messages, before.sessions[id].messages)
    assert.equal(removed.state.sessions[id].providerSessionId, before.sessions[id].providerSessionId)
  }
})

test('sections can be renamed and removed; removing a section returns its projects to default without losing pins or chats', async (t) => {
  const f = fixture(t)
  const { sectionId } = await f.command('upsert_chat_project_section', { label: 'Work' })
  await f.command('upsert_chat_project_section', { sectionId, label: 'Personal work' })
  await f.command('update_chat_project', { projectId: 'project', sectionId, pinned: true })
  const result = await f.command('remove_chat_project_section', { sectionId })
  assert.equal(result.state.chatProjectSections[sectionId], undefined)
  assert.equal(result.state.chatProjects.project.sectionId, undefined)
  assert.equal(result.state.chatProjects.project.pinned, true)
  assert.equal(Object.keys(result.state.sessions).length, 3)
  assert.equal(result.state.sessions.three.chatProjectId, 'project')
})

test('project management validates inputs and human authority before mutating state', async (t) => {
  const f = fixture(t)
  const before = f.runtime.getState()
  const calls = [
    ['update_chat_project', { projectId: 'project', label: '' }],
    ['update_chat_project', { projectId: 'project', pinned: 'yes' }],
    ['update_chat_project', { projectId: 'project', sectionId: 'missing' }],
    ['update_chat_project', { projectId: 'project', cwd: 'relative' }],
    ['remove_chat_project', { projectId: 'missing' }],
    ['archive_chat_project_chats', { projectId: 'missing' }],
    ['upsert_chat_project_section', { label: '' }],
    ['remove_chat_project_section', { sectionId: 'missing' }],
  ]
  for (const [kind, input] of calls) await assert.rejects(f.command(kind, input))
  for (const kind of ['update_chat_project', 'remove_chat_project', 'archive_chat_project_chats', 'upsert_chat_project_section', 'remove_chat_project_section']) {
    await assert.rejects(f.command(kind, { projectId: 'project', label: 'Runtime mutation' }, { kind: 'runtime' }), /human/)
  }
  assert.deepEqual(f.runtime.getState().chatProjects, before.chatProjects)
  assert.deepEqual(f.runtime.getState().chatProjectSections, before.chatProjectSections)
  assert.equal(f.adapter.startedTurns.length, 0)
})

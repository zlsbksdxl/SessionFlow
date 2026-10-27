import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-chat-computers-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const sourceFile = 'src/lib/chat-computers.ts'
const moduleFile = path.join(tempRoot, 'chat-computers.mjs')

async function load() {
  assert.ok(fs.existsSync(sourceFile), 'The computer selection helper must exist')
  fs.writeFileSync(moduleFile, ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
  }).outputText)
  return import(pathToFileURL(moduleFile).href)
}

const alpha = { kind: 'ssh', host: 'alpha', runtimePath: '/opt/sessionflow' }
const beta = { kind: 'ssh', host: 'beta', runtimePath: '/srv/sessionflow' }
const defaults = { projects: [], sessions: [], currentCwd: '/local/current', localCwd: '/local/fallback' }

test('computer identities use the full SSH connection while local is always the first choice', async () => {
  const { computerConnectionId, chatComputerOptions } = await load()
  assert.equal(computerConnectionId(), 'local')
  assert.equal(computerConnectionId({ kind: 'local' }), 'local')
  assert.equal(computerConnectionId(alpha), '["ssh","alpha","/opt/sessionflow"]')
  const result = chatComputerOptions({ ...defaults, projects: [{ projectId: 'remote', connection: alpha, cwd: '/remote/project', updatedAt: '2026-10-27T00:00:00Z' }] })
  assert.deepEqual(result[0], { id: 'local', label: 'This computer', connection: { kind: 'local' }, cwd: '/local/fallback' })
  assert.equal(result[1].id, '["ssh","alpha","/opt/sessionflow"]')
  assert.equal(result[1].cwd, '/remote/project')
})

test('projects and sessions deduplicate by host and runtime with the most recently updated valid cwd winning', async () => {
  const { chatComputerOptions } = await load()
  const result = chatComputerOptions({
    ...defaults,
    projects: [
      { projectId: 'old', connection: alpha, cwd: '/remote/old', updatedAt: '2026-10-25T00:00:00Z' },
      { projectId: 'new', connection: alpha, cwd: '/remote/project', updatedAt: '2026-10-26T00:00:00Z' },
      { projectId: 'untrusted-new', connection: alpha, cwd: 'relative/path', updatedAt: '2026-10-29T00:00:00Z' },
      { projectId: 'beta', connection: beta, cwd: '/beta/project', updatedAt: '2026-10-26T01:00:00Z' },
    ],
    sessions: [
      { sessionId: 'latest', workspaceConnection: alpha, cwd: '/remote/latest-chat', updatedAt: '2026-10-27T00:00:00Z' },
      { sessionId: 'old-beta', workspaceConnection: beta, cwd: '/beta/old-chat', updatedAt: '2026-10-25T00:00:00Z' },
    ],
  })
  assert.equal(result.length, 3)
  assert.equal(result.find((option) => option.connection.host === 'alpha').cwd, '/remote/latest-chat')
  assert.equal(result.find((option) => option.connection.host === 'beta').cwd, '/beta/project')
})

test('the current remote computer survives deleted source projects and keeps the current working directory', async () => {
  const { chatComputerOptions } = await load()
  const result = chatComputerOptions({
    ...defaults, currentConnection: alpha, currentCwd: '/remote/current-draft',
    sessions: [{ sessionId: 'recent', workspaceConnection: alpha, cwd: '/remote/recent', updatedAt: '2026-10-29T00:00:00Z' }],
  })
  assert.equal(result.length, 2)
  assert.equal(result[1].cwd, '/remote/current-draft')
  const deleted = chatComputerOptions({ ...defaults, currentConnection: beta, currentCwd: '/remote/deleted-project' })
  assert.equal(deleted[1].connection.host, 'beta')
  assert.equal(deleted[1].cwd, '/remote/deleted-project')
})

test('separate runtimes on the same SSH host remain separate and their labels identify the runtime folder', async () => {
  const { chatComputerOptions } = await load()
  const result = chatComputerOptions({ ...defaults, projects: [
    { connection: alpha, cwd: '/remote/one', updatedAt: '2026-10-26T00:00:00Z' },
    { connection: { ...alpha, runtimePath: '/srv/other-runtime' }, cwd: '/remote/two', updatedAt: '2026-10-27T00:00:00Z' },
  ] })
  assert.equal(result.length, 3)
  assert.notEqual(result[1].id, result[2].id)
  assert.ok(result.find((option) => option.connection.runtimePath === '/opt/sessionflow').label.includes('/opt/sessionflow'))
  assert.ok(result.find((option) => option.connection.runtimePath === '/srv/other-runtime').label.includes('/srv/other-runtime'))
})

test('incomplete or non-absolute saved remote options are filtered without changing source records', async () => {
  const { chatComputerOptions } = await load()
  const input = { ...defaults, projects: [
    { connection: { ...alpha, host: ' ' }, cwd: '/remote/path' },
    { connection: { ...alpha, runtimePath: '' }, cwd: '/remote/path' },
    { connection: { ...alpha, runtimePath: 'relative/runtime' }, cwd: '/remote/path' },
    { connection: alpha, cwd: '~/project' },
    { connection: alpha, cwd: '' },
    { connection: alpha, cwd: '/remote/path\nother' },
  ] }
  const before = structuredClone(input)
  assert.equal(chatComputerOptions(input).length, 1)
  assert.deepEqual(input, before)
})

test('reselecting the same computer preserves the entire draft including its worktree and explicit project', async () => {
  const { draftForComputer } = await load()
  const current = { connection: alpha, cwd: '/remote/current', projectId: 'explicit-project', workMode: 'local', branch: 'draft-branch' }
  assert.equal(draftForComputer(current, { id: '["ssh","alpha","/opt/sessionflow"]', label: 'alpha', connection: { ...alpha }, cwd: '/remote/fallback' }), current)
  const local = { connection: { kind: 'local' }, cwd: '/local/worktree', projectId: 'local-project', workMode: 'worktree', branch: 'feature' }
  assert.equal(draftForComputer(local, { id: 'local', label: 'This computer', connection: { kind: 'local' }, cwd: '/local/fallback' }), local)
})

test('switching SSH hosts with the same cwd clears membership and stale workspace settings', async () => {
  const { draftForComputer } = await load()
  const current = { connection: alpha, cwd: '/shared/name', projectId: 'alpha-project', workMode: 'worktree', branch: 'alpha-feature' }
  const result = draftForComputer(current, { id: '["ssh","beta","/srv/sessionflow"]', label: 'beta', connection: beta, cwd: '/shared/name' })
  assert.deepEqual(result, { connection: beta, cwd: '/shared/name', projectId: undefined, workMode: 'local', branch: '' })
  assert.equal(current.projectId, 'alpha-project')
})

test('returning from SSH uses the known local directory rather than reinterpreting the remote path locally', async () => {
  const { draftForComputer } = await load()
  const result = draftForComputer({ connection: alpha, cwd: '/remote-only/project', projectId: 'remote-project', workMode: 'local', branch: '' },
    { id: 'local', label: 'This computer', connection: { kind: 'local' }, cwd: '/local/safe-fallback' })
  assert.deepEqual(result, { connection: { kind: 'local' }, cwd: '/local/safe-fallback', projectId: undefined, workMode: 'local', branch: '' })
})

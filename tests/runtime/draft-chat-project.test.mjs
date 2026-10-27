import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-draft-chat-project-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const modulePath = path.join(tempRoot, 'draft-chat-project.mjs')
fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync('src/lib/draft-chat-project.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
}).outputText)
const { projectIdForDraft, projectIdForSelectedCwd } = await import(pathToFileURL(modulePath).href)

function fixture() {
  return {
    chatProjects: {
      alpha: { projectId: 'alpha', name: 'Alpha', cwd: '/work/alpha' },
      beta: { projectId: 'beta', name: 'Beta', cwd: '/work/beta' },
    },
    sessions: {
      'alpha-worktree': { sessionId: 'alpha-worktree', chatProjectId: 'alpha', cwd: '/work/alpha-tree' },
      'beta-worktree': { sessionId: 'beta-worktree', chatProjectId: 'beta', cwd: '/work/beta-tree' },
      'unassigned-worktree': { sessionId: 'unassigned-worktree', cwd: '/work/alpha-tree' },
    },
  }
}

test('No project remains unassigned even when its cwd or linked source matches a registered project', () => {
  const state = fixture()
  assert.equal(projectIdForDraft(state, undefined, '/work/alpha'), undefined)
  assert.equal(projectIdForDraft(state, undefined, '/work/alpha-tree', 'alpha-worktree'), undefined)
  assert.equal(projectIdForDraft(state, undefined, '/work/alpha', 'alpha-worktree'), undefined)
})

test('an explicit project ID accepts its registered root and rejects unknown, deleted, or wrong-cwd projects', () => {
  const state = fixture()
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha'), 'alpha')
  assert.equal(projectIdForDraft(state, 'beta', '/work/beta'), 'beta')
  assert.equal(projectIdForDraft(state, 'unknown', '/work/alpha'), undefined)
  assert.equal(projectIdForDraft(state, 'alpha', '/work/beta'), undefined)
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha/subdirectory'), undefined)
  delete state.chatProjects.alpha
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha'), undefined)
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha-tree', 'alpha-worktree'), undefined)
})

test('linked worktree inheritance requires the exact selected source, same project, and same cwd', () => {
  const state = fixture()
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha-tree', 'alpha-worktree'), 'alpha')
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha-tree'), undefined)
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha-tree', 'missing-source'), undefined)
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha-tree', 'beta-worktree'), undefined)
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha-tree', 'unassigned-worktree'), undefined)
  assert.equal(projectIdForDraft(state, 'alpha', '/work/other-tree', 'alpha-worktree'), undefined)
  assert.equal(projectIdForDraft(state, 'beta', '/work/alpha-tree', 'alpha-worktree'), undefined)
})

test('actively selecting the same registered cwd after No project restores explicit project membership', () => {
  const state = fixture()
  assert.equal(projectIdForDraft(state, undefined, '/work/alpha', 'alpha-worktree'), undefined)
  const selectedId = projectIdForSelectedCwd(state, undefined, '/work/alpha', 'alpha-worktree')
  assert.equal(selectedId, 'alpha')
  assert.equal(projectIdForDraft(state, selectedId, '/work/alpha'), 'alpha')
})

test('selecting a different registered cwd resolves that project while unregistered folders stay unassigned', () => {
  const state = fixture()
  assert.equal(projectIdForSelectedCwd(state, 'alpha', '/work/beta', 'alpha-worktree'), 'beta')
  assert.equal(projectIdForSelectedCwd(state, 'unknown', '/work/beta'), 'beta')
  assert.equal(projectIdForSelectedCwd(state, undefined, '/work/unregistered'), undefined)
  assert.equal(projectIdForSelectedCwd(state, 'alpha', '/work/unregistered', 'alpha-worktree'), undefined)
  assert.equal(projectIdForSelectedCwd(state, undefined, '/work/alpha-tree', 'alpha-worktree'), undefined)
  assert.equal(projectIdForSelectedCwd({ sessions: {} }, undefined, '/work/alpha'), undefined)
})

test('valid linked project membership takes precedence over another registration for the worktree cwd', () => {
  const state = fixture()
  state.chatProjects.tree = { projectId: 'tree', name: 'Tree as separate project', cwd: '/work/alpha-tree' }
  assert.equal(projectIdForSelectedCwd(state, 'alpha', '/work/alpha-tree', 'alpha-worktree'), 'alpha')
  assert.equal(projectIdForSelectedCwd(state, undefined, '/work/alpha-tree', 'alpha-worktree'), 'tree')
})

test('project resolution does not normalize directory identity or mutate state', () => {
  const state = fixture()
  const before = structuredClone(state)
  const cwd = ' /work/alpha '
  assert.equal(projectIdForDraft(state, 'alpha', cwd), undefined)
  assert.equal(projectIdForSelectedCwd(state, 'alpha', cwd), undefined)
  assert.equal(cwd, ' /work/alpha ')
  assert.equal(projectIdForDraft(state, 'alpha', '/work/alpha-tree', 'alpha-worktree'), 'alpha')
  assert.equal(projectIdForSelectedCwd(state, undefined, '/work/beta'), 'beta')
  assert.deepEqual(state, before)
})

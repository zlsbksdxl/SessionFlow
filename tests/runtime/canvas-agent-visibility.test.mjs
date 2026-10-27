import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-canvas-agent-visibility-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const modulePath = path.join(tempRoot, 'canvas-agent-visibility.mjs')
fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync('src/lib/canvas-agent-visibility.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
}).outputText)
const {
  canvasHiddenAgentsStorageKey,
  readHiddenCanvasAgents,
  writeHiddenCanvasAgents,
  setCanvasAgentHidden,
  visibleCanvasGraphState,
  filterVisibleCanvasEdges,
} = await import(pathToFileURL(modulePath).href)

test('hidden Agent preference reload normalizes IDs and preserves valid per-card choices', () => {
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  writeHiddenCanvasAgents([' a ', 'b', 'a', '', '   ', '__proto__'], storage)
  assert.equal(canvasHiddenAgentsStorageKey, 'orrery.canvasHiddenAgents.v1')
  assert.deepEqual(JSON.parse(values.get(canvasHiddenAgentsStorageKey)), ['a', 'b', '__proto__'])
  assert.deepEqual(readHiddenCanvasAgents(storage), ['a', 'b', '__proto__'])
  values.set(canvasHiddenAgentsStorageKey, JSON.stringify(['a', null, 42, {}, ' b ', 'a', '']))
  assert.deepEqual(readHiddenCanvasAgents(storage), ['a', 'b'])
})

test('malformed or inaccessible preference storage cannot break graph rendering', () => {
  for (const value of [null, '', 'bad JSON', '{}', 'null', '42', '"a"']) {
    assert.deepEqual(readHiddenCanvasAgents({ getItem: () => value }), [])
  }
  assert.deepEqual(readHiddenCanvasAgents({ getItem: () => { throw new Error('Storage denied') } }), [])
  assert.doesNotThrow(() => writeHiddenCanvasAgents(['a'], { setItem: () => { throw new Error('Quota exceeded') } }))
  assert.deepEqual(readHiddenCanvasAgents(), [])
  assert.doesNotThrow(() => writeHiddenCanvasAgents(['a']))
})

test('denied default browser storage does not prevent hiding or restoring a card', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { throw new Error('Browser blocked localStorage') },
  } })
  try {
    assert.deepEqual(readHiddenCanvasAgents(), [])
    assert.doesNotThrow(() => writeHiddenCanvasAgents(['a']))
    assert.deepEqual(setCanvasAgentHidden([], 'a', true), ['a'])
    assert.deepEqual(setCanvasAgentHidden(['a'], 'a', false), [])
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete globalThis.window
  }
})

test('hide and restore are immutable, independent per Agent, and no-op updates preserve identity', () => {
  const initial = Object.freeze(['a'])
  const hidden = setCanvasAgentHidden(initial, 'b', true)
  assert.deepEqual(initial, ['a'])
  assert.deepEqual(hidden, ['a', 'b'])
  assert.equal(setCanvasAgentHidden(hidden, 'b', true), hidden)
  assert.equal(setCanvasAgentHidden(hidden, 'missing', false), hidden)
  assert.equal(setCanvasAgentHidden(hidden, '', true), hidden)
  assert.equal(setCanvasAgentHidden(hidden, '   ', false), hidden)
  const restored = setCanvasAgentHidden(hidden, 'a', false)
  assert.deepEqual(restored, ['b'])
  assert.deepEqual(hidden, ['a', 'b'])
})

function stateFixture() {
  return {
    nodes: [{ nodeId: 'a', sessionId: 'a' }, { nodeId: 'b', sessionId: 'b' }],
    sessions: { a: { sessionId: 'a', status: 'running', messages: ['history'] }, b: { sessionId: 'b', status: 'idle' } },
    edges: [{ source: 'a', target: 'b', kind: 'link' }],
    subscriptions: { subscription: { source: 'a', target: 'b', state: 'active' } },
    clusters: { group: { nodeIds: ['a', 'b'] } },
  }
}

test('hiding only removes projected graph nodes, retaining sidebar history and running state', () => {
  const state = stateFixture()
  const visible = visibleCanvasGraphState(state, ['a'])
  assert.notEqual(visible, state)
  assert.deepEqual(visible.nodes, [state.nodes[1]])
  assert.deepEqual(state.nodes.map((node) => node.nodeId), ['a', 'b'])
  assert.equal(visible.sessions, state.sessions)
  assert.equal(visible.sessions.a.status, 'running')
  assert.deepEqual(visible.sessions.a.messages, ['history'])
  assert.equal(visible.edges, state.edges)
  assert.equal(visible.subscriptions, state.subscriptions)
  assert.equal(visible.clusters, state.clusters)
})

test('restoring a card reuses canonical graph and no matching hidden IDs preserve state identity', () => {
  const state = stateFixture()
  assert.equal(visibleCanvasGraphState(state, []), state)
  assert.equal(visibleCanvasGraphState(state, ['missing']), state)
  assert.deepEqual(visibleCanvasGraphState(state, ['a', 'b']).nodes, [])
  const restoredIds = setCanvasAgentHidden(['a'], 'a', false)
  assert.equal(visibleCanvasGraphState(state, restoredIds), state)
  assert.equal(state.sessions.a.status, 'running')
})

test('rendered edges exclude missing endpoints while preserving visible draft and synthetic relationships', () => {
  const nodes = [{ id: 'visible' }, { id: 'draft-agent' }, { id: 'source:one' }]
  const edges = [
    { id: 'hidden-source', source: 'hidden', target: 'visible', kind: 'link' },
    { id: 'hidden-target', source: 'visible', target: 'hidden', kind: 'report' },
    { id: 'missing-both', source: 'gone-one', target: 'gone-two' },
    { id: 'draft', source: 'visible', target: 'draft-agent', type: 'draft' },
    { id: 'synthetic', source: 'source:one', target: 'visible', type: 'readability' },
    { id: 'self', source: 'visible', target: 'visible' },
  ]
  const visible = filterVisibleCanvasEdges(edges, nodes)
  assert.deepEqual(visible.map((edge) => edge.id), ['draft', 'synthetic', 'self'])
  assert.equal(visible[0], edges[3])
  assert.equal(visible[1], edges[4])
  assert.equal(edges.length, 6)
  assert.deepEqual(filterVisibleCanvasEdges(edges, []), [])
})

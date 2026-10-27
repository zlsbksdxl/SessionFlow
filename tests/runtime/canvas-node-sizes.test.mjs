import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-canvas-node-sizes-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const modulePath = path.join(tempRoot, 'canvas-node-sizes.mjs')
fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync('src/lib/canvas-node-sizes.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
}).outputText)
const {
  agentNodeSizeBounds,
  defaultAgentNodeWidth,
  canvasNodeSizesStorageKey,
  normalizeCanvasNodeSize,
  readCanvasNodeSizes,
  writeCanvasNodeSizes,
  updateCanvasNodeSize,
  reconcileCanvasNodePresentation,
} = await import(pathToFileURL(modulePath).href)

test('finite numeric dimensions round to pixels and stay inside the supported card size range', () => {
  assert.deepEqual(agentNodeSizeBounds, { minWidth: 240, maxWidth: 640, minHeight: 140, maxHeight: 520 })
  assert.equal(defaultAgentNodeWidth, 300)
  assert.deepEqual(normalizeCanvasNodeSize({ width: 421.7, height: 260.3 }), { width: 422, height: 260 })
  assert.deepEqual(normalizeCanvasNodeSize({ width: -10, height: 10000 }), { width: 240, height: 520 })
  assert.deepEqual(normalizeCanvasNodeSize({ width: 10000, height: 0 }), { width: 640, height: 140 })
})

test('invalid, missing and non-finite dimensions cannot enter stored presentation sizes', () => {
  for (const value of [null, undefined, [], '300x200', {}, { width: 300 }, { height: 200 },
    { width: '300', height: 200 }, { width: 300, height: '200' },
    { width: Infinity, height: 200 }, { width: NaN, height: 200 }, { width: 300, height: -Infinity }]) {
    assert.equal(normalizeCanvasNodeSize(value), undefined)
  }
})

test('node size updates are immutable and isolated, with stable identity for unchanged or invalid values', () => {
  const original = Object.freeze({ a: Object.freeze({ width: 300, height: 200 }) })
  const next = updateCanvasNodeSize(original, 'b', { width: 450.1, height: 320.1 })
  assert.deepEqual(next, { a: { width: 300, height: 200 }, b: { width: 450, height: 320 } })
  assert.equal(next.a, original.a)
  assert.equal(Object.hasOwn(original, 'b'), false)
  assert.equal(updateCanvasNodeSize(next, 'b', { width: 450.4, height: 320.4 }), next)
  assert.equal(updateCanvasNodeSize(next, 'a', { width: Infinity, height: 200 }), next)
})

test('arbitrary node IDs are safe own properties and round-trip through storage', () => {
  let sizes = updateCanvasNodeSize({}, '__proto__', { width: 380, height: 210 })
  sizes = updateCanvasNodeSize(sizes, 'constructor', { width: 420, height: 220 })
  assert.equal(Object.getPrototypeOf(sizes), Object.prototype)
  assert.equal(Object.hasOwn(sizes, '__proto__'), true)
  assert.deepEqual(sizes.__proto__, { width: 380, height: 210 })
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  writeCanvasNodeSizes(sizes, storage)
  assert.ok(values.has(canvasNodeSizesStorageKey))
  assert.deepEqual(readCanvasNodeSizes(storage), sizes)
})

test('storage reload validates entries individually and tolerates missing, malformed or denied storage', () => {
  assert.deepEqual(readCanvasNodeSizes({ getItem: () => null }), {})
  for (const raw of ['invalid JSON', 'null', '[]', '42', '"string"']) {
    assert.deepEqual(readCanvasNodeSizes({ getItem: () => raw }), {})
  }
  assert.deepEqual(readCanvasNodeSizes({ getItem: () => JSON.stringify({ valid: { width: 401.4, height: 240 },
    invalid: { width: '400', height: 200 }, bounded: { width: 10, height: 1000 } }) }), {
    valid: { width: 401, height: 240 }, bounded: { width: 240, height: 520 },
  })
  assert.deepEqual(readCanvasNodeSizes({ getItem: () => { throw new Error('Storage denied') } }), {})
  assert.doesNotThrow(() => writeCanvasNodeSizes({ a: { width: 300, height: 200 } }, { setItem: () => { throw new Error('Quota exceeded') } }))
  assert.deepEqual(readCanvasNodeSizes(), {})
  assert.doesNotThrow(() => writeCanvasNodeSizes({ a: { width: 300, height: 200 } }))
})

test('default browser storage access denial does not prevent rendering or resizing', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { throw new Error('Browser blocked localStorage') },
  } })
  try {
    assert.deepEqual(readCanvasNodeSizes(), {})
    assert.doesNotThrow(() => writeCanvasNodeSizes({ a: { width: 400, height: 220 } }))
    assert.deepEqual(updateCanvasNodeSize({}, 'a', { width: 400, height: 220 }), { a: { width: 400, height: 220 } })
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete globalThis.window
  }
})

test('projection refresh keeps selection and unchanged measurements while accepting fresh runtime content', () => {
  const measured = { width: 300, height: 187 }
  const current = [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, selected: true, measured, data: { description: 'old' } }]
  const projected = [{ id: 'a', type: 'agent', position: { x: 10, y: 20 }, data: { description: 'new' } }]
  const next = reconcileCanvasNodePresentation(projected, current)
  assert.equal(next[0].selected, true)
  assert.equal(next[0].measured, measured)
  assert.deepEqual(next[0].position, { x: 10, y: 20 })
  assert.deepEqual(next[0].data, { description: 'new' })
  assert.equal(projected[0].selected, undefined)
  assert.deepEqual(current[0].data, { description: 'old' })
})

test('in-flight Agent resizing survives a streaming projection without freezing its runtime data', () => {
  const current = [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, selected: true, resizing: true,
    width: 478, height: 315, measured: { width: 478, height: 315 }, style: { width: 478, height: 315 }, data: { status: 'running', description: 'old' } }]
  const projected = [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, width: 300, height: 200,
    style: { width: 300, height: 200 }, data: { status: 'running', description: 'streamed content' } }]
  const [next] = reconcileCanvasNodePresentation(projected, current)
  assert.equal(next.resizing, true)
  assert.deepEqual({ width: next.width, height: next.height }, { width: 478, height: 315 })
  assert.deepEqual(next.style, { width: 478, height: 315 })
  assert.equal(next.measured, current[0].measured)
  assert.equal(next.data.description, 'streamed content')
})

test('finalized projected dimensions win and stale measurements and resizing flags are dropped', () => {
  const current = [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, selected: true, resizing: false,
    width: 478, height: 315, measured: { width: 478, height: 315 }, style: { width: 478, height: 315 }, data: {} }]
  const projected = [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, width: 510, height: 360,
    style: { width: 510, height: 360 }, data: {} }]
  const [next] = reconcileCanvasNodePresentation(projected, current)
  assert.equal(next.width, 510)
  assert.equal(next.height, 360)
  assert.deepEqual(next.style, { width: 510, height: 360 })
  assert.equal(next.measured, undefined)
  assert.equal(next.resizing, undefined)
  assert.equal(next.selected, true)
})

test('new projected nodes retain their presentation and removed nodes cannot reappear', () => {
  const projected = [{ id: 'new', type: 'agent', position: { x: 0, y: 0 }, selected: true, data: {} }]
  const current = [{ id: 'removed', type: 'agent', position: { x: 10, y: 20 }, selected: true, data: {} }]
  assert.deepEqual(reconcileCanvasNodePresentation(projected, current), projected)
})

test('explicit projected draft selection wins over a previous local selection', () => {
  const current = [
    { id: 'draft-a', type: 'draft-agent', position: { x: 0, y: 0 }, selected: true, data: {} },
    { id: 'draft-b', type: 'draft-agent', position: { x: 0, y: 0 }, selected: false, data: {} },
  ]
  const projected = [
    { ...current[0], selected: false },
    { ...current[1], selected: true },
  ]
  assert.deepEqual(reconcileCanvasNodePresentation(projected, current).map((node) => node.selected), [false, true])
})

test('north and west resize keep their in-flight origin through stale streaming projections, then accept the finalized origin', () => {
  const current = [{ id: 'a', type: 'agent', position: { x: -35, y: -22 }, selected: true, resizing: true,
    width: 335, height: 222, measured: { width: 335, height: 222 }, data: { description: 'old' } }]
  const staleProjected = [{ id: 'a', type: 'agent', position: { x: 0, y: 0 },
    width: 300, height: 200, data: { description: 'new stream content' } }]
  const [inFlight] = reconcileCanvasNodePresentation(staleProjected, current)
  assert.deepEqual(inFlight.position, { x: -35, y: -22 })
  assert.equal(inFlight.width, 335)
  assert.equal(inFlight.height, 222)
  assert.equal(inFlight.data.description, 'new stream content')
  assert.deepEqual(staleProjected[0].position, { x: 0, y: 0 }, 'projection remains immutable')

  const finalizedCurrent = [{ ...inFlight, resizing: false }]
  const finalizedProjected = [{ ...staleProjected[0], position: { x: -48, y: -30 }, width: 348, height: 230 }]
  const [finalized] = reconcileCanvasNodePresentation(finalizedProjected, finalizedCurrent)
  assert.deepEqual(finalized.position, { x: -48, y: -30 })
  assert.equal(finalized.width, 348)
  assert.equal(finalized.height, 230)
  assert.equal(finalized.resizing, undefined)
})

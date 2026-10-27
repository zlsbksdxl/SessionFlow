import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-project-order-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const sourceFile = 'src/lib/project-order.ts'
const moduleFile = path.join(tempRoot, 'project-order.mjs')
async function load() {
  assert.ok(fs.existsSync(sourceFile), 'The project order helper must exist')
  fs.writeFileSync(moduleFile, ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
  }).outputText)
  return import(pathToFileURL(moduleFile).href)
}

test('saved project order filters invalid IDs and duplicates without mutating its source', async () => {
  const { normalizeProjectOrder, projectOrderStorageKey } = await load()
  assert.equal(projectOrderStorageKey, 'orrery.projectOrder.v1')
  const input = ['alpha', 1, null, '', ' ', ' beta ', 'alpha', 'beta', 'bad\nkey', '\tbad', 'bad\u007fkey', 'x'.repeat(513), '项目-id', 'x'.repeat(512)]
  const before = [...input]
  assert.deepEqual(normalizeProjectOrder(input), ['alpha', 'beta', '项目-id', 'x'.repeat(512)])
  assert.deepEqual(input, before)
  for (const invalid of [undefined, null, {}, '[]', 1]) assert.deepEqual(normalizeProjectOrder(invalid), [])
})

test('manual ranks survive activity changes while new projects append in current input order', async () => {
  const { orderProjectGroups } = await load()
  const alpha = { key: 'alpha', chats: [{ sessionId: 'chat-a' }] }
  const beta = { key: 'beta', chats: [{ sessionId: 'chat-b' }] }
  const newer = { key: 'new', chats: [] }
  const otherNew = { key: 'other-new', chats: [] }
  const order = ['removed', 'beta', 'alpha']
  assert.deepEqual(orderProjectGroups([alpha, beta], order).map((group) => group.key), ['beta', 'alpha'])
  assert.deepEqual(orderProjectGroups([newer, alpha, otherNew, beta], order).map((group) => group.key), ['beta', 'alpha', 'new', 'other-new'])
  assert.deepEqual(orderProjectGroups([beta, newer, alpha], order).map((group) => group.key), ['beta', 'alpha', 'new'])
  assert.deepEqual(orderProjectGroups([alpha, newer], order).map((group) => group.key), ['alpha', 'new'])
})

test('project sorting preserves input groups, their chat order and original object references', async () => {
  const { orderProjectGroups } = await load()
  const firstChat = Object.freeze({ sessionId: 'first-chat' })
  const secondChat = Object.freeze({ sessionId: 'second-chat' })
  const alpha = Object.freeze({ key: 'alpha', chats: Object.freeze([firstChat, secondChat]) })
  const beta = Object.freeze({ key: 'beta', chats: Object.freeze([]) })
  const input = Object.freeze([alpha, beta])
  const order = Object.freeze(['beta', 'beta', 'alpha'])
  const result = orderProjectGroups(input, order)
  assert.deepEqual(result, [beta, alpha])
  assert.equal(result[0], beta)
  assert.equal(result[1], alpha)
  assert.equal(result[1].chats, alpha.chats)
  assert.deepEqual(input, [alpha, beta])
  assert.deepEqual(orderProjectGroups(input, []), [alpha, beta])
})

test('projects move before and after their target in either direction', async () => {
  const { moveProjectInOrder } = await load()
  const input = Object.freeze(['alpha', 'beta', 'gamma', 'delta'])
  assert.deepEqual(moveProjectInOrder(input, 'alpha', 'gamma', 'before'), ['beta', 'alpha', 'gamma', 'delta'])
  assert.deepEqual(moveProjectInOrder(input, 'alpha', 'gamma', 'after'), ['beta', 'gamma', 'alpha', 'delta'])
  assert.deepEqual(moveProjectInOrder(input, 'delta', 'beta', 'before'), ['alpha', 'delta', 'beta', 'gamma'])
  assert.deepEqual(moveProjectInOrder(input, 'delta', 'beta', 'after'), ['alpha', 'beta', 'delta', 'gamma'])
  assert.deepEqual(moveProjectInOrder(input, 'alpha', 'alpha', 'after'), input)
  assert.deepEqual(moveProjectInOrder(input, 'missing', 'beta', 'before'), input)
  assert.deepEqual(moveProjectInOrder(input, 'alpha', 'missing', 'after'), input)
  assert.deepEqual(input, ['alpha', 'beta', 'gamma', 'delta'])
})

test('only distinct own projects in the same section and pin bucket can reorder', async () => {
  const { sameProjectOrderBucket } = await load()
  const projects = Object.assign(Object.create({ inherited: { projectId: 'inherited' } }), {
    alpha: { projectId: 'alpha' }, beta: { projectId: 'beta', pinned: false },
    pinned: { projectId: 'pinned', pinned: true }, otherPinned: { projectId: 'otherPinned', pinned: true },
    sectionA: { projectId: 'sectionA', sectionId: 'a' }, sameSectionA: { projectId: 'sameSectionA', sectionId: 'a' },
    sectionB: { projectId: 'sectionB', sectionId: 'b' }, sectionPinned: { projectId: 'sectionPinned', sectionId: 'a', pinned: true },
  })
  assert.equal(sameProjectOrderBucket(projects, 'alpha', 'beta'), true)
  assert.equal(sameProjectOrderBucket(projects, 'pinned', 'otherPinned'), true)
  assert.equal(sameProjectOrderBucket(projects, 'sectionA', 'sameSectionA'), true)
  for (const [source, target] of [['alpha', 'alpha'], ['alpha', 'pinned'], ['alpha', 'sectionA'], ['sectionA', 'sectionB'], ['sectionA', 'sectionPinned'], ['missing', 'alpha'], ['alpha', 'inherited'], ['alpha', 'toString'], ['alpha', '__proto__']]) {
    assert.equal(sameProjectOrderBucket(projects, source, target), false, `${source} / ${target}`)
  }
})

test('project drag payloads are private, bounded and versioned with exactly their declared fields', async () => {
  const { encodeProjectReorder, decodeProjectReorder, projectReorderMime } = await load()
  assert.equal(projectReorderMime, 'application/x-orrery-project-order')
  assert.deepEqual(JSON.parse(encodeProjectReorder(' alpha ')), { version: 1, projectId: 'alpha' })
  assert.deepEqual(decodeProjectReorder(encodeProjectReorder('项目-id')), { projectId: '项目-id' })
  assert.deepEqual(decodeProjectReorder(encodeProjectReorder('x'.repeat(512))), { projectId: 'x'.repeat(512) })
  for (const value of ['', ' ', 'bad\nkey', '\tbad', 'x'.repeat(513), null, 5]) assert.throws(() => encodeProjectReorder(value), /project/i)
  for (const value of [undefined, null, 1, '', '{', 'null', '[]', '{}', 'https://foreign.example/project', ' '.repeat(4097),
    JSON.stringify({ version: 2, projectId: 'alpha' }), JSON.stringify({ projectId: 'alpha' }),
    JSON.stringify({ version: 1, sessionId: 'alpha' }), JSON.stringify({ version: 1, projectId: [] }),
    JSON.stringify({ version: 1, projectId: 'bad\nkey' }), JSON.stringify({ version: 1, projectId: ' ' }),
    JSON.stringify({ version: 1, projectId: 'x'.repeat(513) }), JSON.stringify({ version: 1, projectId: 'alpha', target: 'beta' }),
  ]) assert.equal(decodeProjectReorder(value), undefined)
})

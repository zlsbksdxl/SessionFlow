import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-relationship-prompts-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const modulePath = path.join(tempRoot, 'relationship-prompts.mjs')
fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync('src/lib/relationship-prompts.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
}).outputText)
const {
  relationshipPromptsStorageKey,
  relationshipPromptKey,
  readRelationshipPrompt,
  writeRelationshipPrompt,
} = await import(pathToFileURL(modulePath).href)

function memoryStorage(initial) {
  const entries = new Map(initial === undefined ? [] : [[relationshipPromptsStorageKey, initial]])
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  }
}

test('relationship identities separate history from automation and prefer the subscription identity', () => {
  assert.equal(relationshipPromptKey({ edgeId: 'one' }), 'edge:one')
  assert.equal(relationshipPromptKey({ subscriptionId: 'one' }), 'subscription:one')
  assert.equal(relationshipPromptKey({ edgeId: 'event', subscriptionId: 'intent' }), 'subscription:intent')
  assert.equal(relationshipPromptKey({ edgeId: ' edge ', subscriptionId: ' ' }), 'edge:edge')
  assert.equal(relationshipPromptKey({}), undefined)
  assert.equal(relationshipPromptKey({ edgeId: ' ', subscriptionId: '' }), undefined)
})

test('saving persists a multiline relationship description and preserves other relationship prompts', () => {
  const storage = memoryStorage()
  writeRelationshipPrompt('edge:one', '  Agent A writes the implementation.\n\nAgent B checks its behavior.  ', storage)
  writeRelationshipPrompt('subscription:one', 'Review every completed result.', storage)
  assert.equal(relationshipPromptsStorageKey, 'orrery.relationshipPrompts.v1')
  assert.equal(readRelationshipPrompt('edge:one', storage), 'Agent A writes the implementation.\n\nAgent B checks its behavior.')
  assert.equal(readRelationshipPrompt('subscription:one', storage), 'Review every completed result.')
  writeRelationshipPrompt('edge:one', 'Updated description', storage)
  assert.equal(readRelationshipPrompt('edge:one', storage), 'Updated description')
  assert.equal(readRelationshipPrompt('subscription:one', storage), 'Review every completed result.')
})

test('clearing one description removes only that relationship entry', () => {
  const storage = memoryStorage()
  writeRelationshipPrompt('edge:a', 'First relation', storage)
  writeRelationshipPrompt('edge:b', 'Second relation', storage)
  writeRelationshipPrompt('edge:a', ' \n ', storage)
  assert.equal(readRelationshipPrompt('edge:a', storage), '')
  assert.equal(readRelationshipPrompt('edge:b', storage), 'Second relation')
  assert.deepEqual(JSON.parse(storage.getItem(relationshipPromptsStorageKey)), { 'edge:b': 'Second relation' })
})

test('malformed storage cannot break reading, and saving repairs it without inventing prompt content', () => {
  for (const raw of [undefined, '', 'bad JSON', 'null', '42', '"text"', '[]']) {
    const storage = memoryStorage(raw)
    assert.equal(readRelationshipPrompt('edge:a', storage), '')
    writeRelationshipPrompt('edge:a', 'Saved', storage)
    assert.equal(readRelationshipPrompt('edge:a', storage), 'Saved')
  }
  const storage = memoryStorage(JSON.stringify({ 'edge:a': 'Valid', 'edge:b': 42, 'subscription:c': null, 'edge:d': '', unexpected: 'Ignored' }))
  assert.equal(readRelationshipPrompt('edge:a', storage), 'Valid')
  assert.equal(readRelationshipPrompt('edge:b', storage), '')
  assert.equal(readRelationshipPrompt('subscription:c', storage), '')
  assert.equal(readRelationshipPrompt('unexpected', storage), '')
  writeRelationshipPrompt('edge:e', 'Another', storage)
  assert.deepEqual(JSON.parse(storage.getItem(relationshipPromptsStorageKey)), { 'edge:a': 'Valid', 'edge:e': 'Another' })
})

test('unavailable or denied storage is safe to read and explicitly fails on save', () => {
  assert.equal(readRelationshipPrompt('edge:a', { getItem() { throw new Error('Read denied') } }), '')
  assert.throws(() => writeRelationshipPrompt('edge:a', 'A', {
    getItem() { throw new Error('Read denied') },
    setItem() { assert.fail('must not overwrite unreadable prompts') },
  }), /Read denied/)
  assert.throws(() => writeRelationshipPrompt('edge:a', 'A', {
    getItem: () => null,
    setItem() { throw new Error('Quota exceeded') },
  }), /Quota exceeded/)
  assert.equal(readRelationshipPrompt('edge:a'), '')
  assert.throws(() => writeRelationshipPrompt('edge:a', 'A'), /storage is unavailable/)
})

test('a blocked browser storage getter cannot produce a false saved state', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { throw new Error('Browser blocked storage') },
  } })
  try {
    assert.equal(readRelationshipPrompt('edge:a'), '')
    assert.throws(() => writeRelationshipPrompt('edge:a', 'A'), /Browser blocked storage/)
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete globalThis.window
  }
})

test('invalid identities cannot create orphan entries, and special ID text is stored safely', () => {
  const storage = memoryStorage()
  for (const key of ['', 'edge:', 'subscription:', 'edge:   ', '__proto__']) {
    assert.equal(readRelationshipPrompt(key, storage), '')
    assert.throws(() => writeRelationshipPrompt(key, 'Invalid', storage), /Choose a relationship/)
  }
  writeRelationshipPrompt('edge:__proto__', 'Valid edge identity', storage)
  assert.equal(readRelationshipPrompt('edge:__proto__', storage), 'Valid edge identity')
  assert.deepEqual(JSON.parse(storage.getItem(relationshipPromptsStorageKey)), { 'edge:__proto__': 'Valid edge identity' })
})

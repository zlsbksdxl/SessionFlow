import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-session-composer-settings-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const modulePath = path.join(tempRoot, 'session-composer-settings.mjs')
fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync('src/lib/session-composer-settings.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
}).outputText)
const {
  sessionComposerSettingsBaseline,
  sessionComposerSettingsValues,
  sessionComposerSettingsPatch,
  updateSessionComposerSettingsDraft,
  clearSessionComposerSettingsDraft,
} = await import(pathToFileURL(modulePath).href)

function session(sessionId, runtimeSettings, effectiveRuntimeConfig) {
  return { sessionId, providerKind: 'codex', runtimeSettings, effectiveRuntimeConfig }
}

test('baseline uses stored mode and effort before effective config, preserving explicit empty model', () => {
  assert.deepEqual(sessionComposerSettingsBaseline(session('a', {
    runtimeMode: 'approval-required', model: '', reasoningEffort: 'low',
  }, { runtimeMode: 'full-access', model: 'native-model', reasoningEffort: 'xhigh' })), {
    providerKind: 'codex', runtimeMode: 'approval-required', model: '', reasoningEffort: 'low',
  })
})

test('effective config fills mode and effort while an unset model retains provider default', () => {
  assert.deepEqual(sessionComposerSettingsBaseline(session('a', undefined, {
    runtimeMode: 'auto-accept-edits', model: 'native-model', reasoningEffort: 'high',
  })), { providerKind: 'codex', runtimeMode: 'auto-accept-edits', model: '', reasoningEffort: 'high' })
  assert.deepEqual(sessionComposerSettingsBaseline(undefined), {
    providerKind: 'claude-code', runtimeMode: 'auto', model: '', reasoningEffort: 'medium',
  })
})

test('unchanged settings yield no patch, and a changed model can explicitly clear to provider default', () => {
  const baseline = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'auto', model: 'custom', reasoningEffort: 'medium' }))
  assert.equal(sessionComposerSettingsPatch(baseline, undefined), undefined)
  assert.equal(sessionComposerSettingsPatch(baseline, {}), undefined)
  assert.equal(sessionComposerSettingsPatch(baseline, baseline), undefined)
  assert.deepEqual(sessionComposerSettingsPatch(baseline, { model: '' }), { model: '' })
  assert.equal(sessionComposerSettingsValues(baseline, { model: '' }).model, '')
  assert.deepEqual(sessionComposerSettingsPatch(baseline, { runtimeMode: 'full-access' }), { runtimeMode: 'full-access' })
})

test('switching between sessions preserves independent field drafts and never mutates the original map', () => {
  const a = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'auto', model: 'model-a', reasoningEffort: 'medium' }))
  const b = sessionComposerSettingsBaseline(session('b', { runtimeMode: 'approval-required', model: 'model-b', reasoningEffort: 'low' }))
  const empty = new Map()
  let drafts = updateSessionComposerSettingsDraft(empty, 'a', a, { model: '' })
  drafts = updateSessionComposerSettingsDraft(drafts, 'a', a, { runtimeMode: 'full-access' })
  drafts = updateSessionComposerSettingsDraft(drafts, 'b', b, { reasoningEffort: 'high' })
  assert.equal(empty.size, 0)
  assert.deepEqual(sessionComposerSettingsPatch(a, drafts.get('a')), { model: '', runtimeMode: 'full-access' })
  assert.deepEqual(sessionComposerSettingsPatch(b, drafts.get('b')), { reasoningEffort: 'high' })
  assert.equal(sessionComposerSettingsValues(b, drafts.get('b')).model, 'model-b')
  assert.equal(sessionComposerSettingsValues(b, drafts.get('b')).runtimeMode, 'approval-required')
})

test('runtime refresh changes untouched fields but preserves pending field changes', () => {
  const baseline = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'auto', model: 'original', reasoningEffort: 'low' }))
  const drafts = updateSessionComposerSettingsDraft(new Map(), 'a', baseline, { model: 'pending-model' })
  const refreshed = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'approval-required', model: 'runtime-model', reasoningEffort: 'high' }))
  assert.deepEqual(sessionComposerSettingsValues(refreshed, drafts.get('a')), {
    providerKind: 'codex', runtimeMode: 'approval-required', model: 'pending-model', reasoningEffort: 'high',
  })
  assert.deepEqual(sessionComposerSettingsPatch(refreshed, drafts.get('a')), { model: 'pending-model' })
})

test('reverting one field removes only that override, and reverting all clears its draft', () => {
  const baseline = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'auto', model: 'original', reasoningEffort: 'medium' }))
  let drafts = updateSessionComposerSettingsDraft(new Map(), 'a', baseline, { model: 'pending', runtimeMode: 'full-access' })
  drafts = updateSessionComposerSettingsDraft(drafts, 'a', baseline, { runtimeMode: 'auto' })
  assert.deepEqual(drafts.get('a'), { model: 'pending' })
  drafts = updateSessionComposerSettingsDraft(drafts, 'a', baseline, { model: 'original' })
  assert.equal(drafts.has('a'), false)
  assert.equal(sessionComposerSettingsPatch(baseline, drafts.get('a')), undefined)
  assert.equal(updateSessionComposerSettingsDraft(drafts, 'a', baseline, { model: 'original' }), drafts)
})

test('clearing the submitted session keeps another session draft and is safe for missing sessions', () => {
  const baseline = sessionComposerSettingsBaseline(undefined)
  let drafts = updateSessionComposerSettingsDraft(new Map(), 'a', baseline, { runtimeMode: 'full-access' })
  drafts = updateSessionComposerSettingsDraft(drafts, 'b', baseline, { model: 'other-model' })
  const cleared = clearSessionComposerSettingsDraft(drafts, 'a')
  assert.equal(drafts.has('a'), true)
  assert.equal(cleared.has('a'), false)
  assert.deepEqual(cleared.get('b'), { model: 'other-model' })
  assert.equal(clearSessionComposerSettingsDraft(cleared, undefined), cleared)
  assert.equal(clearSessionComposerSettingsDraft(cleared, 'missing'), cleared)
})

test('a runtime baseline that already matches a draft produces no redundant next-turn patch', () => {
  const previous = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'auto', model: 'original', reasoningEffort: 'medium' }))
  const drafts = updateSessionComposerSettingsDraft(new Map(), 'a', previous, { runtimeMode: 'approval-required', reasoningEffort: 'high' })
  const current = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'approval-required', model: 'original', reasoningEffort: 'high' }))
  assert.equal(sessionComposerSettingsPatch(current, drafts.get('a')), undefined)
})

test('an applied draft is reconciled away and cannot revive when runtime settings change again', () => {
  const original = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'auto', model: '', reasoningEffort: 'medium' }))
  let drafts = updateSessionComposerSettingsDraft(new Map(), 'a', original, { runtimeMode: 'approval-required' })
  const applied = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'approval-required', model: '', reasoningEffort: 'medium' }))
  drafts = updateSessionComposerSettingsDraft(drafts, 'a', applied, {})
  assert.equal(drafts.has('a'), false)
  assert.equal(sessionComposerSettingsPatch(applied, drafts.get('a')), undefined)
  const later = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'full-access', model: '', reasoningEffort: 'medium' }))
  assert.equal(sessionComposerSettingsValues(later, drafts.get('a')).runtimeMode, 'full-access')
  assert.equal(sessionComposerSettingsPatch(later, drafts.get('a')), undefined)
  assert.equal(updateSessionComposerSettingsDraft(drafts, 'a', later, {}), drafts, 'unchanged reconciliation preserves Map identity')
})

test('reconciliation removes only applied fields and preserves other pending edits and sessions', () => {
  const original = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'auto', model: 'old-model', reasoningEffort: 'medium' }))
  let drafts = updateSessionComposerSettingsDraft(new Map(), 'a', original, { runtimeMode: 'approval-required', model: '', reasoningEffort: 'high' })
  drafts = updateSessionComposerSettingsDraft(drafts, 'b', original, { model: 'other-draft' })
  const partiallyApplied = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'approval-required', model: 'old-model', reasoningEffort: 'medium' }))
  const reconciled = updateSessionComposerSettingsDraft(drafts, 'a', partiallyApplied, {})
  assert.deepEqual(reconciled.get('a'), { model: '', reasoningEffort: 'high' })
  assert.deepEqual(reconciled.get('b'), { model: 'other-draft' })
  assert.deepEqual(drafts.get('a'), { runtimeMode: 'approval-required', model: '', reasoningEffort: 'high' })
  assert.equal(updateSessionComposerSettingsDraft(reconciled, 'a', partiallyApplied, {}), reconciled)
  const later = sessionComposerSettingsBaseline(session('a', { runtimeMode: 'full-access', model: 'new-runtime-model', reasoningEffort: 'low' }))
  assert.deepEqual(sessionComposerSettingsValues(later, reconciled.get('a')), {
    providerKind: 'codex', runtimeMode: 'full-access', model: '', reasoningEffort: 'high',
  })
})

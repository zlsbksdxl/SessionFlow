import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRendererModule } from './support/load-renderer-module.mjs';

test('member chat navigation preserves the mounted group and returns to its exact workspace', async (t) => {
  const { initialWorkspaceNavigation: initial, transitionWorkspaceNavigation: go } = await loadRendererModule('src/lib/workspace-navigation.ts', t);
  const group = go(initial, { type: 'workspace', workspaceId: 'group-a' });
  const member = go(group, { type: 'chat', fromWorkspaceId: 'group-a' });
  assert.equal(member.activeTab, 'chat');
  assert.equal(member.selectedWorkspaceId, 'group-a', 'hidden group must remain mounted');
  assert.equal(member.returnToWorkspaceId, 'group-a');
  const returned = go(member, { type: 'back-to-workspace' });
  assert.equal(returned.activeTab, 'workspace');
  assert.equal(returned.selectedWorkspaceId, 'group-a');
  assert.equal(returned.returnToWorkspaceId, undefined);
});

test('ordinary and imported chats clear stale return/setup/council targets with explicit import reset', async (t) => {
  const { initialWorkspaceNavigation: initial, transitionWorkspaceNavigation: go } = await loadRendererModule('src/lib/workspace-navigation.ts', t);
  const before = {
    ...initial,
    selectedWorkspaceId: 'group-a',
    returnToWorkspaceId: 'group-a',
    providerSetupSessionId: 'old',
    openPlanCouncilId: 'council-a',
    isNativeSessionImportOpen: true,
    showRawEvents: true,
  };
  const chat = go(before, { type: 'chat' });
  assert.equal(chat.selectedWorkspaceId, 'group-a');
  assert.equal(chat.returnToWorkspaceId, undefined);
  assert.equal(chat.providerSetupSessionId, undefined);
  assert.equal(chat.openPlanCouncilId, undefined);
  assert.equal(chat.showRawEvents, true, 'ordinary navigation preserves diagnostics display preference');
  const imported = go(before, { type: 'chat', imported: true });
  assert.equal(imported.selectedWorkspaceId, undefined);
  assert.equal(imported.isNativeSessionImportOpen, false);
  const setup = go(before, { type: 'chat', providerSetupSessionId: 'next' });
  assert.equal(setup.providerSetupSessionId, 'next');
  assert.equal(setup.showRawEvents, false);
});

test('Council continuation retains its destination draft and workflow navigation records its product target', async (t) => {
  const { initialWorkspaceNavigation: initial, transitionWorkspaceNavigation: go } = await loadRendererModule('src/lib/workspace-navigation.ts', t);
  const council = go(initial, { type: 'council-started', workflowId: 'plans' });
  assert.equal(council.openPlanCouncilId, 'plans');
  const continued = go(council, { type: 'workspace', workspaceId: 'group-b', draft: 'Continue these findings' });
  assert.equal(continued.openPlanCouncilId, undefined);
  assert.deepEqual(continued.workspaceDraft, { workspaceId: 'group-b', text: 'Continue these findings' });
  const review = go(continued, { type: 'workflow-started', loopId: 'review-1', notice: 'Ready for review' });
  assert.equal(review.activeTab, 'chat');
  assert.equal(review.openLoopId, 'review-1');
  assert.equal(review.workflowNotice, 'Ready for review');
  assert.equal(review.selectedWorkspaceId, 'group-b', 'workflow navigation must not unnecessarily unmount group state');
  const fresh = go(review, { type: 'new-chat' });
  assert.equal(fresh.returnToWorkspaceId, undefined);
  assert.equal(fresh.providerSetupSessionId, undefined);
});

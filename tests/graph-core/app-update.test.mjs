import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appUpdateDisabledReason,
  enableAppUpdates,
  initialAppUpdateState,
  markAppUpdateAvailable,
  markAppUpdateError,
  markAppUpToDate,
  startAppUpdateCheck,
  appUpdateRuntimeBlockers,
} from '../../dist-electron/shared/app-update.js';

test('automatic update checks are limited to packaged macOS arm64 builds with a feed', () => {
  assert.equal(
    appUpdateDisabledReason({
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
      hasFeedConfig: true,
    }),
    undefined,
  );
  assert.match(
    appUpdateDisabledReason({
      isPackaged: false,
      platform: 'darwin',
      arch: 'arm64',
      hasFeedConfig: true,
    }),
    /packaged builds/,
  );
  assert.match(
    appUpdateDisabledReason({
      isPackaged: true,
      platform: 'darwin',
      arch: 'x64',
      hasFeedConfig: true,
    }),
    /Apple Silicon/,
  );
  assert.match(
    appUpdateDisabledReason({
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
      hasFeedConfig: false,
    }),
    /feed/,
  );
});

test('automatic installation waits for provider, queue and workflow activity while terminal history is idle', () => {
  assert.deepEqual(appUpdateRuntimeBlockers({ sessions: { old: { status: 'failed' }, paused: { status: 'idle', threadGoal: { status: 'paused' } } }, workflowPlans: { done: { 1: { status: 'completed' } } }, planCouncils: { finished: { phase: 'completed' } } }), []);
  for (const state of [
    { sessions: { one: { status: 'pending' } } },
    { sessions: { one: { status: 'running' } } },
    { sessions: { one: { status: 'idle', threadGoal: { status: 'active' } } } },
    { runQueue: [{}] }, { workspaceLeases: [{ status: 'active' }] }, { pendingActivations: { turn: {} } },
    { clusters: { group: { loopState: { status: 'running' } } } }, { planCouncils: { council: { phase: 'ready-for-synthesis' } } },
    { workflowPlans: { plan: { 1: { status: 'active' } } } }, { dynamicSpawnGroups: { group: { status: 'creating' } } },
    { collaborationSessions: { group: { discussions: { one: { status: 'active' } } } } },
  ]) assert.ok(appUpdateRuntimeBlockers(state).length > 0);
});

test('update detection state keeps the available version until a no-update result', () => {
  const initial = enableAppUpdates(initialAppUpdateState('0.1.0'));
  const checking = startAppUpdateCheck(initial, '2026-07-21T00:00:00.000Z');
  const available = markAppUpdateAvailable(checking, '0.2.0', '2026-07-21T00:00:01.000Z', '2026-07-20T00:00:00.000Z');

  assert.equal(available.status, 'available');
  assert.equal(available.currentVersion, '0.1.0');
  assert.equal(available.availableVersion, '0.2.0');
  assert.equal(available.releaseDate, '2026-07-20T00:00:00.000Z');

  const failed = markAppUpdateError(available, 'network unavailable', '2026-07-21T00:00:02.000Z');
  assert.equal(failed.availableVersion, '0.2.0');
  assert.equal(failed.status, 'error');

  const current = markAppUpToDate(failed, '2026-07-21T00:00:03.000Z');
  assert.equal(current.status, 'up-to-date');
  assert.equal(current.availableVersion, undefined);
  assert.equal(current.message, undefined);
});

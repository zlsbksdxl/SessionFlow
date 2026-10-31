import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRendererModule } from './support/load-renderer-module.mjs';

const target = { providerKind: 'codex', providerInstanceId: 'profile-a', profileFingerprint: 'fingerprint-a', cwd: '/workspace' };
const connection = { kind: 'ssh', host: 'gpu', runtimePath: '/opt/sessionflow' };

test('readiness target identities distinguish profile, host, runtime and cwd while normalizing local connections', async (t) => {
  const { workspaceProviderSetupTargetKey: key } = await loadRendererModule('src/lib/workspace-provider-setup.ts', t);
  assert.equal(key(target), key({ ...target, connection: { kind: 'local' }, cwd: ' /workspace ' }));
  for (const patch of [
    { providerInstanceId: 'profile-b' },
    { profileFingerprint: 'fingerprint-b' },
    { cwd: '/elsewhere' },
    { connection },
    { connection: { ...connection, runtimePath: '/other' } },
  ]) {
    assert.notEqual(key(target), key({ ...target, ...patch }));
  }
  assert.notEqual(key({ ...target, connection }), key({ ...target, connection: { ...connection, host: 'other' } }));
});

test('local and SSH errors retain all selection identity used by new-chat admission and existing-chat diagnostics', async (t) => {
  const { workspaceProviderSetupFailure: failure, workspaceConnectionKey } = await loadRendererModule('src/lib/workspace-provider-setup.ts', t);
  for (const selected of [target, { ...target, connection }]) {
    const result = failure(selected, new Error('connection failed'));
    assert.equal(result.providerKind, selected.providerKind);
    assert.equal(result.providerInstanceId, selected.providerInstanceId);
    assert.equal(result.profileFingerprint, selected.profileFingerprint);
    assert.equal(result.cwd, selected.cwd);
    assert.equal(result.workspaceConnectionKey, workspaceConnectionKey(selected.connection));
    assert.equal(result.checks[0].message, 'connection failed');
    assert.equal(result.checks[0].id, selected.connection ? 'protocol' : 'setup-status');
    if (selected.connection) assert.equal(result.readiness, 'unavailable');
  }
});

test('local readiness uses the configured profile and SSH readiness maps remote auth/protocol into the same result contract', async (t) => {
  const { loadWorkspaceProviderSetupStatus: load } = await loadRendererModule('src/lib/workspace-provider-setup.ts', t);
  const local = await load({
    ...target,
    runtimeApi: {
      getProviderSetupStatus: async (input) => {
        assert.deepEqual(input, { providerKind: 'codex', providerInstanceId: 'profile-a', cwd: '/workspace' });
        return { ...target, checks: [] };
      },
    },
  });
  assert.equal(local.workspaceConnectionKey, 'local');
  for (const status of ['ready', 'auth-error', 'setup-error', 'unavailable']) {
    const remote = await load({
      ...target,
      connection,
      runtimeApi: {
        dispatchCommand: async (request) => {
          assert.equal(request.kind, 'test_chat_project_connection');
          assert.deepEqual(request.input.connection, connection);
          return { ok: true, cwd: '/workspace', providers: { codex: { available: status !== 'unavailable', status, message: status } } };
        },
      },
    });
    assert.equal(remote.cwd, target.cwd);
    assert.equal(remote.profileFingerprint, target.profileFingerprint);
    assert.equal(remote.readiness, status === 'ready' ? 'ready' : status === 'auth-error' ? 'needs-attention' : 'unavailable');
    assert.equal(remote.auth.status, status === 'auth-error' ? 'unauthenticated' : 'unknown');
  }
});
